"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Bug,
  CheckCircle2,
  CircleDashed,
  Clock,
  Eye,
  FlaskConical,
  History as HistoryIcon,
  Loader2,
  MessageSquarePlus,
  Newspaper,
  Pencil,
  Play,
  Plus,
  Radar,
  ScrollText,
  ShieldCheck,
  Sparkles,
  Trash2,
  TrendingUp,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { SettingsPageHeader, inputClass } from "@/components/settings/shared";
import { useSettings } from "@/components/settings/SettingsContext";
import { stashComposerDraft } from "@/lib/composer-draft";
import {
  createCronJob,
  deleteCronJob,
  describeCronSchedule,
  formatCronDuration,
  formatCronInstant,
  listCronJobs,
  listCronRuns,
  listCronTemplates,
  patchCronJob,
  runCronJob,
  templateToCreatePayload,
  type CronJob,
  type CronRunEntry,
  type CronRunRecord,
  type CronTemplate,
} from "@/lib/cron-api";
import { listSessions, type SessionSummary } from "@/lib/session-api";

const TEMPLATE_ICONS: Record<string, LucideIcon> = {
  Newspaper,
  Eye,
  Radar,
  TrendingUp,
  ShieldCheck,
  Bug,
  FlaskConical,
  ScrollText,
};

type ScheduleKind = "at" | "every" | "cron";
type AutomationsTab = "configured" | "history" | "templates";

type Draft = {
  name: string;
  message: string;
  session_id: string;
  kind: ScheduleKind;
  at: string;
  every_minutes: string;
  cron_expr: string;
  tz: string;
};

const emptyDraft = (): Draft => ({
  name: "",
  message: "",
  session_id: "",
  kind: "every",
  at: "",
  every_minutes: "60",
  cron_expr: "0 9 * * 1-5",
  tz: "",
});

function toLocalInputValue(ms: number): string {
  const date = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
    date.getDate(),
  )}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Prefill the form from an existing task so it can be edited in place. */
function draftFromJob(job: CronJob): Draft {
  const schedule = job.schedule;
  return {
    name: job.name,
    message: job.message,
    session_id: job.owner.session_id,
    kind: schedule.kind,
    at: schedule.at_ms ? toLocalInputValue(schedule.at_ms) : "",
    every_minutes: schedule.every_seconds
      ? String(Math.max(1, Math.round(schedule.every_seconds / 60)))
      : "60",
    cron_expr: schedule.expr ?? "",
    tz: schedule.tz ?? "",
  };
}

function toPayload(draft: Draft): Parameters<typeof createCronJob>[0] {
  const body: Parameters<typeof createCronJob>[0] = {
    name: draft.name,
    message: draft.message,
    session_id: draft.session_id,
  };
  if (draft.kind === "at") {
    const parsed = new Date(draft.at);
    body.at = Number.isNaN(parsed.getTime()) ? draft.at : parsed.toISOString();
  }
  if (draft.kind === "every") {
    const minutes = Number(draft.every_minutes);
    if (!Number.isFinite(minutes) || minutes < 1) {
      throw new Error("Interval must be at least one minute.");
    }
    body.every_seconds = Math.round(minutes * 60);
  }
  if (draft.kind === "cron") {
    if (!draft.cron_expr.trim()) throw new Error("Cron expression is required.");
    body.cron_expr = draft.cron_expr.trim();
    if (draft.tz) body.tz = draft.tz;
  }
  return body;
}

function validScheduleDraft(draft: Draft): boolean {
  if (!draft.message.trim()) return false;
  if (draft.kind === "every") {
    const minutes = Number(draft.every_minutes);
    return Number.isFinite(minutes) && minutes >= 1;
  }
  if (draft.kind === "at") return !Number.isNaN(new Date(draft.at).getTime());
  return Boolean(draft.cron_expr.trim());
}

export default function AutomationsSettingsPage() {
  const { t } = useTranslation();
  const router = useRouter();
  const { language } = useSettings();
  const locale = language === "zh" ? "zh-CN" : "en-US";
  const [tab, setTab] = useState<AutomationsTab>("configured");
  const [jobs, setJobs] = useState<CronJob[] | null>(null);
  const [journal, setJournal] = useState<CronRunEntry[] | null>(null);
  const [templates, setTemplates] = useState<CronTemplate[] | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyIds, setBusyIds] = useState<Set<string>>(() => new Set());
  const busyIdsRef = useRef(new Set<string>());
  const reloadEpochRef = useRef(0);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [formOpen, setFormOpen] = useState(false);
  // When set, the visible form edits this task instead of creating a new one.
  const [editingJob, setEditingJob] = useState<CronJob | null>(null);

  /** Journal + per-job history, deduped into one descending timeline. */
  const runs = useMemo(() => {
    const seen = new Set<string>();
    const merged: Array<
      CronRunRecord & { jobId: string; jobName: string }
    > = [];
    const push = (jobId: string, jobName: string, record: CronRunRecord) => {
      const key = `${jobId}:${record.run_at_ms}`;
      if (seen.has(key)) return;
      seen.add(key);
      merged.push({ ...record, jobId, jobName });
    };
    for (const job of jobs ?? []) {
      for (const record of job.state.run_history ?? []) {
        push(job.id, job.name || job.message, record);
      }
    }
    for (const entry of journal ?? []) {
      push(entry.job_id, entry.job_name, entry);
    }
    return merged.sort((a, b) => b.run_at_ms - a.run_at_ms);
  }, [jobs, journal]);

  const sessionTitle = useMemo(() => {
    const map = new Map<string, string>();
    for (const session of sessions) {
      map.set(session.session_id, session.title || session.session_id);
    }
    return map;
  }, [sessions]);

  const reload = useCallback(async () => {
    const epoch = ++reloadEpochRef.current;
    const [nextJobs, nextJournal, nextSessions] = await Promise.all([
      listCronJobs(),
      listCronRuns(200).catch(() => [] as CronRunEntry[]),
      listSessions(200, 0, { force: true }).catch(() => [] as SessionSummary[]),
    ]);
    if (reloadEpochRef.current !== epoch) return;
    setJobs(nextJobs);
    setJournal(nextJournal);
    setSessions(nextSessions);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void reload().catch((err) => {
      if (!cancelled) {
        setError(err instanceof Error ? err.message : String(err));
        setJobs([]);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [reload]);

  // Runs land while this page sits open — re-sync on focus like the chat page.
  useEffect(() => {
    const resync = () => void reload().catch(() => {});
    window.addEventListener("focus", resync);
    window.addEventListener("pageshow", resync);
    document.addEventListener("visibilitychange", resync);
    return () => {
      window.removeEventListener("focus", resync);
      window.removeEventListener("pageshow", resync);
      document.removeEventListener("visibilitychange", resync);
    };
  }, [reload]);

  // Templates are static product content — load once per UI language.
  useEffect(() => {
    let cancelled = false;
    setTemplates(null);
    listCronTemplates(language)
      .then((next) => {
        if (!cancelled) setTemplates(next);
      })
      .catch(() => {
        if (!cancelled) setTemplates([]);
      });
    return () => {
      cancelled = true;
    };
  }, [language]);

  const act = useCallback(
    async (id: string, work: () => Promise<void>) => {
      if (busyIdsRef.current.has(id)) return;
      busyIdsRef.current.add(id);
      setBusyIds((current) => new Set(current).add(id));
      setError(null);
      try {
        await work();
        await reload();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyIds((current) => {
          busyIdsRef.current.delete(id);
          const next = new Set(current);
          next.delete(id);
          return next;
        });
      }
    },
    [reload],
  );

  const closeForm = useCallback(() => {
    setFormOpen(false);
    setEditingJob(null);
    setDraft(emptyDraft());
  }, []);

  const handleSubmit = useCallback(async () => {
    setCreating(true);
    setError(null);
    try {
      if (editingJob) {
        const payload = toPayload(draft);
        // The backend rebuilds the schedule from any of its fields it sees.
        // A one-shot time the user left untouched and already past must be
        // omitted, or validation would reject the whole update ("in the past").
        const atTime = draft.kind === "at" ? new Date(draft.at).getTime() : NaN;
        const omitSchedule = !Number.isNaN(atTime) && atTime <= Date.now();
        const body: Parameters<typeof patchCronJob>[1] = omitSchedule
          ? { name: payload.name, message: payload.message }
          : payload;
        await patchCronJob(editingJob.id, body);
      } else {
        await createCronJob(toPayload(draft));
      }
      closeForm();
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }, [closeForm, draft, editingJob, reload]);

  /** Blank form, or prefilled from a template card click. */
  const openCreate = useCallback((template?: CronTemplate) => {
    if (template) {
      const prefilled = templateToCreatePayload(template);
      const isInterval = template.schedule.kind === "every";
      const minutes = template.schedule.every_seconds
        ? Math.max(1, Math.round(template.schedule.every_seconds / 60))
        : 60;
      setDraft({
        ...emptyDraft(),
        name: prefilled.name ?? "",
        message: prefilled.message ?? "",
        kind: isInterval ? "every" : "cron",
        every_minutes: String(minutes),
        cron_expr: template.schedule.expr || "0 9 * * *",
        tz: template.schedule.tz ?? "",
      });
    } else {
      setDraft(emptyDraft());
    }
    setEditingJob(null);
    setFormOpen(true);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  const openEdit = useCallback((job: CronJob) => {
    setDraft(draftFromJob(job));
    setEditingJob(job);
    setFormOpen(true);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  // The chat agent owns the cron tool too — hand it a starter sentence and
  // let it schedule the automation in conversation (prefilled, not auto-sent).
  const openInChat = useCallback(() => {
    stashComposerDraft(
      t(
        'Set up an automation for me — for example: "Every weekday at 9am, send me a brief of AI industry news."',
      ),
    );
    router.push("/home");
  }, [router, t]);

  /** Send one template straight to the chat agent as the instruction. */
  const chatFromTemplate = useCallback(
    (template: CronTemplate) => {
      stashComposerDraft(template.message);
      router.push("/home");
    },
    [router],
  );

  const switchTab = useCallback(
    (next: AutomationsTab) => {
      setTab(next);
      // Live data tabs re-sync on switch; templates are static content.
      if (next !== "templates") void reload().catch(() => {});
    },
    [reload],
  );

  const tabs: Array<{ id: AutomationsTab; label: string }> = [
    { id: "configured", label: t("Configured") },
    { id: "history", label: t("Run history") },
    { id: "templates", label: t("Task templates") },
  ];

  return (
    <div>
      <SettingsPageHeader
        title={t("Automations")}
        description={t(
          "Configure and manage automation tasks. Knorvia runs workflows on your plan.",
        )}
      />

      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1 border-b border-[var(--border)]">
          {tabs.map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => switchTab(entry.id)}
              className={`-mb-px border-b-2 px-3 py-2 text-[13.5px] font-medium transition-colors ${
                tab === entry.id
                  ? "border-[var(--foreground)] text-[var(--foreground)]"
                  : "border-transparent text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
              }`}
            >
              {entry.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() =>
              formOpen && !editingJob ? closeForm() : openCreate()
            }
            className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border)] px-3 py-1.5 text-[13px] text-[var(--foreground)] hover:bg-[var(--muted)]/50"
          >
            <Plus size={14} />
            {t("New automation")}
          </button>
          <button
            type="button"
            onClick={openInChat}
            title={t(
              'Ask the agent to set up an automation for you, e.g. "Every weekday at 9am, send me a brief of AI industry news."',
            )}
            className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--foreground)] px-3 py-1.5 text-[13px] text-[var(--background)] hover:opacity-90"
          >
            <MessageSquarePlus size={14} />
            {t("Create in chat")}
          </button>
        </div>
      </div>

      {formOpen ? (
        <AutomationCreateForm
          heading={
            editingJob ? t("Edit automation") : t("New automation")
          }
          draft={draft}
          setDraft={setDraft}
          sessions={sessions}
          sessionTitle={sessionTitle}
          creating={creating}
          valid={validScheduleDraft(draft)}
          submitLabel={editingJob ? t("Save changes") : t("Schedule")}
          onSubmit={() => void handleSubmit()}
          onCancel={closeForm}
        />
      ) : null}

      {error ? (
        <p className="mb-4 text-[13px] text-rose-600 dark:text-rose-400">
          {error}
        </p>
      ) : null}

      {tab === "configured" ? (
        <ConfiguredTabContent
          jobs={jobs}
          busyIds={busyIds}
          locale={locale}
          sessions={sessions}
          sessionTitle={sessionTitle}
          onShowTemplates={() => switchTab("templates")}
          onBindSession={async (id, sessionId) => {
            await patchCronJob(id, { session_id: sessionId });
            await reload();
          }}
          onToggleEnabled={(id, enabled) =>
            void act(id, async () => {
              await patchCronJob(id, { enabled });
            })
          }
          onRunNow={(id) =>
            void act(id, async () => {
              await runCronJob(id);
            })
          }
          onEdit={openEdit}
          onDelete={(id) =>
            void act(id, async () => {
              await deleteCronJob(id);
            })
          }
        />
      ) : null}

      {tab === "history" ? (
        <HistoryTabContent
          runs={runs}
          ready={jobs !== null}
          locale={locale}
        />
      ) : null}

      {tab === "templates" ? (
        <TemplatesTabContent
          templates={templates}
          onApply={openCreate}
          onChat={chatFromTemplate}
          chatTitle={t("Create this automation in chat instead")}
        />
      ) : null}
    </div>
  );
}

/* ── create / edit form ───────────────────────────────────────── */

function AutomationCreateForm({
  heading,
  draft,
  setDraft,
  sessions,
  sessionTitle,
  creating,
  valid,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  heading: string;
  draft: Draft;
  setDraft: React.Dispatch<React.SetStateAction<Draft>>;
  sessions: SessionSummary[];
  sessionTitle: Map<string, string>;
  creating: boolean;
  valid: boolean;
  submitLabel: string;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  return (
    <form
      className="mb-6 space-y-3 rounded-xl border border-[var(--border)] bg-[var(--card)]/40 p-4"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <p className="text-[13px] font-medium text-[var(--foreground)]">
        {heading}
      </p>
      <input
        className={inputClass}
        placeholder={t("Name")}
        value={draft.name}
        onChange={(event) =>
          setDraft((current) => ({ ...current, name: event.target.value }))
        }
      />
      <textarea
        className={`${inputClass} min-h-[88px]`}
        required
        placeholder={t("Instruction to run when due")}
        value={draft.message}
        onChange={(event) =>
          setDraft((current) => ({ ...current, message: event.target.value }))
        }
      />
      <label className="block text-[12px] text-[var(--muted-foreground)]">
        {t("Bind to conversation")}
        <select
          className={`${inputClass} mt-1`}
          value={draft.session_id}
          onChange={(event) =>
            setDraft((current) => ({
              ...current,
              session_id: event.target.value,
            }))
          }
        >
          <option value="">{t("Current user · no specific chat")}</option>
          {sessions.map((session) => (
            <option key={session.session_id} value={session.session_id}>
              {sessionTitle.get(session.session_id) || session.session_id}
            </option>
          ))}
        </select>
      </label>
      <div className="flex flex-wrap gap-2">
        {(["every", "at", "cron"] as ScheduleKind[]).map((kind) => (
          <button
            key={kind}
            type="button"
            onClick={() => setDraft((current) => ({ ...current, kind }))}
            className={`rounded-full px-3 py-1 text-[12px] ${
              draft.kind === kind
                ? "bg-[var(--foreground)] text-[var(--background)]"
                : "bg-[var(--muted)]/60 text-[var(--muted-foreground)]"
            }`}
          >
            {kind === "every"
              ? t("Interval")
              : kind === "at"
                ? t("Once")
                : t("Cron")}
          </button>
        ))}
      </div>
      {draft.kind === "every" ? (
        <label className="block text-[12px] text-[var(--muted-foreground)]">
          {t("Every N minutes")}
          <input
            className={`${inputClass} mt-1`}
            type="number"
            min={1}
            required
            value={draft.every_minutes}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                every_minutes: event.target.value,
              }))
            }
          />
        </label>
      ) : null}
      {draft.kind === "at" ? (
        <label className="block text-[12px] text-[var(--muted-foreground)]">
          {t("Run at")}
          <input
            className={`${inputClass} mt-1`}
            type="datetime-local"
            required
            value={draft.at}
            onChange={(event) =>
              setDraft((current) => ({ ...current, at: event.target.value }))
            }
          />
        </label>
      ) : null}
      {draft.kind === "cron" ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <input
            className={inputClass}
            placeholder={t("Cron expression")}
            required
            value={draft.cron_expr}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                cron_expr: event.target.value,
              }))
            }
          />
          <input
            className={inputClass}
            placeholder={t("Timezone (optional)")}
            value={draft.tz}
            onChange={(event) =>
              setDraft((current) => ({ ...current, tz: event.target.value }))
            }
          />
        </div>
      ) : null}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg px-3 py-1.5 text-[13px] text-[var(--muted-foreground)]"
        >
          {t("Cancel")}
        </button>
        <button
          type="submit"
          disabled={creating || !valid}
          className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--foreground)] px-3 py-1.5 text-[13px] text-[var(--background)] disabled:opacity-50"
        >
          {creating ? <Loader2 size={14} className="animate-spin" /> : null}
          {submitLabel}
        </button>
      </div>
    </form>
  );
}

/* ── configured tab ───────────────────────────────────────────── */

function ConfiguredTabContent({
  jobs,
  busyIds,
  locale,
  sessions,
  sessionTitle,
  onShowTemplates,
  onBindSession,
  onToggleEnabled,
  onRunNow,
  onEdit,
  onDelete,
}: {
  jobs: CronJob[] | null;
  busyIds: Set<string>;
  locale: string;
  sessions: SessionSummary[];
  sessionTitle: Map<string, string>;
  onShowTemplates: () => void;
  onBindSession: (id: string, sessionId: string) => Promise<void>;
  onToggleEnabled: (id: string, enabled: boolean) => void;
  onRunNow: (id: string) => void;
  onEdit: (job: CronJob) => void;
  onDelete: (id: string) => void;
}) {
  const { t } = useTranslation();

  if (jobs === null) {
    return (
      <div className="flex items-center gap-2 text-[13px] text-[var(--muted-foreground)]">
        <Loader2 size={14} className="animate-spin" />
        {t("Loading…")}
      </div>
    );
  }

  if (jobs.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-[var(--border)] px-5 py-14 text-center">
        <span className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-[var(--muted)]/60 text-[var(--muted-foreground)]">
          <Clock size={20} />
        </span>
        <p className="text-[13.5px] text-[var(--muted-foreground)]">
          {t("No automations configured yet.")}
        </p>
        <button
          type="button"
          onClick={onShowTemplates}
          className="mt-4 inline-flex items-center gap-1.5 rounded-full bg-[var(--foreground)] px-4 py-2 text-[13px] font-medium text-[var(--background)] hover:opacity-90"
        >
          {t("Start from a template")}
          <Play size={13} />
        </button>
      </div>
    );
  }

  return (
    <>
      <p className="mb-3 text-[12px] text-[var(--muted-foreground)]">
        {t("{{count}} automation(s)", { count: jobs.length })}
      </p>
      <ul className="space-y-3">
        {jobs.map((job) => (
          <AutomationCard
            key={job.id}
            job={job}
            busy={busyIds.has(job.id)}
            locale={locale}
            sessions={sessions}
            sessionTitle={sessionTitle}
            onBindSession={onBindSession}
            onToggleEnabled={onToggleEnabled}
            onRunNow={onRunNow}
            onEdit={onEdit}
            onDelete={onDelete}
          />
        ))}
      </ul>
    </>
  );
}

function AutomationCard({
  job,
  busy,
  locale,
  sessions,
  sessionTitle,
  onBindSession,
  onToggleEnabled,
  onRunNow,
  onEdit,
  onDelete,
}: {
  job: CronJob;
  busy: boolean;
  locale: string;
  sessions: SessionSummary[];
  sessionTitle: Map<string, string>;
  onBindSession: (id: string, sessionId: string) => Promise<void>;
  onToggleEnabled: (id: string, enabled: boolean) => void;
  onRunNow: (id: string) => void;
  onEdit: (job: CronJob) => void;
  onDelete: (id: string) => void;
}) {
  const { t } = useTranslation();
  const bound = job.owner.session_id;
  return (
    <li className="rounded-xl border border-[var(--border)] bg-[var(--card)]/40 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-[14px] font-medium text-[var(--foreground)]">
              {job.name || job.message}
            </h2>
            <span
              className={`rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wide ${
                job.enabled
                  ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                  : "bg-[var(--muted)] text-[var(--muted-foreground)]"
              }`}
            >
              {job.enabled ? t("On") : t("Off")}
            </span>
          </div>
          <p className="mt-1 line-clamp-2 text-[12.5px] text-[var(--muted-foreground)]">
            {job.message}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            disabled={busy}
            onClick={() => onRunNow(job.id)}
            className="inline-flex items-center gap-1 rounded-lg border border-[var(--border)] px-2.5 py-1 text-[12px] hover:bg-[var(--muted)]/50 disabled:opacity-50"
          >
            {busy ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
            {t("Run now")}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => onToggleEnabled(job.id, !job.enabled)}
            className="rounded-lg border border-[var(--border)] px-2.5 py-1 text-[12px] hover:bg-[var(--muted)]/50 disabled:opacity-50"
          >
            {job.enabled ? t("Pause") : t("Resume")}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => onEdit(job)}
            className="inline-flex items-center gap-1 rounded-lg border border-[var(--border)] px-2.5 py-1 text-[12px] hover:bg-[var(--muted)]/50 disabled:opacity-50"
          >
            <Pencil size={12} />
            {t("Edit")}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              window.confirm(t("Delete this automation?"))
                ? onDelete(job.id)
                : undefined
            }
            className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[12px] text-rose-600 hover:bg-rose-500/10 disabled:opacity-50"
          >
            <Trash2 size={12} />
            {t("Delete")}
          </button>
        </div>
      </div>
      <dl className="mt-3 grid gap-2 text-[12px] text-[var(--muted-foreground)] sm:grid-cols-2">
        <div>
          <dt className="uppercase tracking-wide opacity-70">{t("Schedule")}</dt>
          <dd className="mt-0.5 text-[var(--foreground)]">
            {describeCronSchedule(job.schedule, locale)}
          </dd>
        </div>
        <div>
          <dt className="uppercase tracking-wide opacity-70">{t("Next run")}</dt>
          <dd className="mt-0.5 text-[var(--foreground)]">
            {formatCronInstant(job.state.next_run_at_ms, locale)}
          </dd>
        </div>
        <div>
          <dt className="uppercase tracking-wide opacity-70">{t("Last run")}</dt>
          <dd className="mt-0.5 text-[var(--foreground)]">
            {formatCronInstant(job.state.last_run_at_ms, locale)}
            {job.state.last_status
              ? ` · ${statusLabel(job.state.last_status, t)}`
              : ""}
          </dd>
        </div>
        <div>
          <dt className="uppercase tracking-wide opacity-70">
            {t("Conversation")}
          </dt>
          <dd className="mt-0.5">
            <select
              className={`${inputClass} py-1 text-[12px]`}
              value={bound}
              disabled={busy}
              onChange={(event) => onBindSession(job.id, event.target.value)}
            >
              <option value="">{t("Unbound")}</option>
              {bound && !sessionTitle.has(bound) ? (
                <option value={bound}>{bound}</option>
              ) : null}
              {sessions.map((session) => (
                <option key={session.session_id} value={session.session_id}>
                  {session.title || session.session_id}
                </option>
              ))}
            </select>
            {bound ? (
              <Link
                href={`/home/${encodeURIComponent(bound)}`}
                className="mt-1 inline-block text-[11px] hover:text-[var(--foreground)]"
              >
                {sessionTitle.get(bound) || bound}
              </Link>
            ) : null}
          </dd>
        </div>
      </dl>
    </li>
  );
}

/* ── history tab ──────────────────────────────────────────────── */

function statusLabel(
  status: string,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  if (status === "ok") return t("Successful");
  if (status === "error") return t("Failed");
  if (status === "skipped") return t("Skipped");
  return status;
}

function HistoryTabContent({
  runs,
  ready,
  locale,
}: {
  runs: Array<CronRunRecord & { jobId: string; jobName: string }>;
  ready: boolean;
  locale: string;
}) {
  const { t } = useTranslation();

  if (!ready) {
    return (
      <div className="flex items-center gap-2 text-[13px] text-[var(--muted-foreground)]">
        <Loader2 size={14} className="animate-spin" />
        {t("Loading…")}
      </div>
    );
  }

  if (runs.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-[var(--border)] px-5 py-14 text-center">
        <HistoryIcon
          size={20}
          className="mx-auto mb-3 text-[var(--muted-foreground)]"
        />
        <p className="text-[13.5px] text-[var(--muted-foreground)]">
          {t("No runs yet. History appears here after an automation fires.")}
        </p>
      </div>
    );
  }

  return (
    <ul className="space-y-2">
      {runs.map((run, index) => (
        <li
          key={`${run.jobId}-${run.run_at_ms}-${index}`}
          className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-[var(--border)] bg-[var(--card)]/40 px-4 py-3"
        >
          <RunStatusIcon status={run.status} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] font-medium text-[var(--foreground)]">
              {run.jobName}
              <span
                className={`ml-2 text-[11px] font-normal ${
                  run.status === "error"
                    ? "text-rose-600 dark:text-rose-400"
                    : "text-[var(--muted-foreground)]"
                }`}
              >
                {statusLabel(run.status, t)}
              </span>
            </p>
            {run.error ? (
              <p
                className="mt-0.5 truncate text-[12px] text-rose-600 dark:text-rose-400"
                title={run.error}
              >
                {run.error}
              </p>
            ) : null}
          </div>
          <span className="text-[12px] tabular-nums text-[var(--muted-foreground)]">
            {formatCronDuration(run.duration_ms)}
          </span>
          <span className="text-[12px] tabular-nums text-[var(--muted-foreground)]">
            {new Date(run.run_at_ms).toLocaleString(locale)}
          </span>
        </li>
      ))}
    </ul>
  );
}

function RunStatusIcon({ status }: { status: string }) {
  if (status === "ok") {
    return (
      <CheckCircle2
        size={16}
        className="shrink-0 text-emerald-600 dark:text-emerald-400"
      />
    );
  }
  if (status === "error") {
    return (
      <XCircle size={16} className="shrink-0 text-rose-600 dark:text-rose-400" />
    );
  }
  return (
    <CircleDashed size={16} className="shrink-0 text-[var(--muted-foreground)]" />
  );
}

/* ── templates tab ────────────────────────────────────────────── */

function TemplatesTabContent({
  templates,
  onApply,
  onChat,
  chatTitle,
}: {
  templates: CronTemplate[] | null;
  onApply: (template: CronTemplate) => void;
  onChat: (template: CronTemplate) => void;
  chatTitle: string;
}) {
  const { t } = useTranslation();

  if (templates === null) {
    return (
      <div className="flex items-center gap-2 text-[13px] text-[var(--muted-foreground)]">
        <Loader2 size={14} className="animate-spin" />
        {t("Loading…")}
      </div>
    );
  }

  if (templates.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-[var(--border)] px-5 py-10 text-center text-[13px] text-[var(--muted-foreground)]">
        {t("No task templates available.")}
      </p>
    );
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {templates.map((template) => {
        const Icon = TEMPLATE_ICONS[template.icon] ?? Sparkles;
        return (
          <div
            key={template.id}
            role="button"
            tabIndex={0}
            title={template.description}
            onClick={() => onApply(template)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onApply(template);
              }
            }}
            className="group cursor-pointer rounded-xl border border-[var(--border)] bg-[var(--card)]/40 p-4 text-left transition-colors hover:border-[var(--foreground)]/30 hover:bg-[var(--card)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-500"
          >
            <div className="mb-3 flex items-start justify-between">
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-cyan-500/10 text-cyan-600 transition-transform group-hover:scale-105 dark:text-cyan-400">
                <Icon size={18} />
              </span>
              <button
                type="button"
                title={chatTitle}
                aria-label={chatTitle}
                onClick={(event) => {
                  event.stopPropagation();
                  onChat(template);
                }}
                className="rounded-lg p-1.5 text-[var(--muted-foreground)] opacity-0 transition-opacity hover:bg-[var(--muted)]/60 hover:text-[var(--foreground)] focus-visible:opacity-100 group-hover:opacity-100"
              >
                <MessageSquarePlus size={15} />
              </button>
            </div>
            <h2 className="text-[14px] font-medium text-[var(--foreground)]">
              {template.title}
            </h2>
            <p className="mt-1 line-clamp-2 text-[12.5px] leading-relaxed text-[var(--muted-foreground)]">
              {template.description}
            </p>
          </div>
        );
      })}
    </div>
  );
}
