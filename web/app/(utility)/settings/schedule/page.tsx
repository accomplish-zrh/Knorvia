"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  CalendarClock,
  Loader2,
  Play,
  Plus,
  Trash2,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { SettingsPageHeader, inputClass } from "@/components/settings/shared";
import { useSettings } from "@/components/settings/SettingsContext";
import {
  createCronJob,
  deleteCronJob,
  describeCronSchedule,
  formatCronInstant,
  listCronJobs,
  patchCronJob,
  runCronJob,
  type CronJob,
} from "@/lib/cron-api";
import { listSessions, type SessionSummary } from "@/lib/session-api";

type ScheduleKind = "at" | "every" | "cron";

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

export default function ScheduleSettingsPage() {
  const { t } = useTranslation();
  const { language } = useSettings();
  const locale = language === "zh" ? "zh-CN" : "en-US";
  const [jobs, setJobs] = useState<CronJob[] | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyIds, setBusyIds] = useState<Set<string>>(() => new Set());
  const busyIdsRef = useRef(new Set<string>());
  const reloadEpochRef = useRef(0);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [formOpen, setFormOpen] = useState(false);

  const sessionTitle = useMemo(() => {
    const map = new Map<string, string>();
    for (const session of sessions) {
      map.set(session.session_id, session.title || session.session_id);
    }
    return map;
  }, [sessions]);

  const reload = useCallback(async () => {
    const epoch = ++reloadEpochRef.current;
    const [nextJobs, nextSessions] = await Promise.all([
      listCronJobs(),
      listSessions(200, 0, { force: true }).catch(() => [] as SessionSummary[]),
    ]);
    if (reloadEpochRef.current !== epoch) return;
    setJobs(nextJobs);
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

  const handleCreate = useCallback(async () => {
    setCreating(true);
    setError(null);
    try {
      await createCronJob(toPayload(draft));
      setDraft(emptyDraft());
      setFormOpen(false);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }, [draft, reload]);

  return (
    <div>
      <SettingsPageHeader
        title={t("Scheduled tasks")}
        description={t(
          "Jobs already scheduled by the chat agent. See the next run, run one now, or bind the reply to a conversation.",
        )}
      />

      <div className="mb-4 flex items-center justify-between">
        <p className="text-[12px] text-[var(--muted-foreground)]">
          {jobs
            ? t("{{count}} scheduled task(s)", { count: jobs.length })
            : t("Loading…")}
        </p>
        <button
          type="button"
          onClick={() => setFormOpen((open) => !open)}
          className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border)] px-3 py-1.5 text-[13px] text-[var(--foreground)] hover:bg-[var(--muted)]/50"
        >
          <Plus size={14} />
          {t("New task")}
        </button>
      </div>

      {formOpen ? (
        <form
          className="mb-6 space-y-3 rounded-xl border border-[var(--border)] bg-[var(--card)]/40 p-4"
          onSubmit={(event) => {
            event.preventDefault();
            void handleCreate();
          }}
        >
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
              setDraft((current) => ({
                ...current,
                message: event.target.value,
              }))
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
                  {session.title || session.session_id}
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
              onClick={() => setFormOpen(false)}
              className="rounded-lg px-3 py-1.5 text-[13px] text-[var(--muted-foreground)]"
            >
              {t("Cancel")}
            </button>
            <button
              type="submit"
              disabled={creating || !validScheduleDraft(draft)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--foreground)] px-3 py-1.5 text-[13px] text-[var(--background)] disabled:opacity-50"
            >
              {creating ? <Loader2 size={14} className="animate-spin" /> : null}
              {t("Schedule")}
            </button>
          </div>
        </form>
      ) : null}

      {error ? (
        <p className="mb-4 text-[13px] text-rose-600 dark:text-rose-400">{error}</p>
      ) : null}

      {jobs === null ? (
        <div className="flex items-center gap-2 text-[13px] text-[var(--muted-foreground)]">
          <Loader2 size={14} className="animate-spin" />
          {t("Loading…")}
        </div>
      ) : jobs.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[var(--border)] px-5 py-10 text-center text-[13px] text-[var(--muted-foreground)]">
          <CalendarClock className="mx-auto mb-2" size={20} />
          {t("No scheduled tasks yet. Ask the chat agent, or create one here.")}
        </div>
      ) : (
        <ul className="space-y-3">
          {jobs.map((job) => {
            const busy = busyIds.has(job.id);
            const bound = job.owner.session_id;
            return (
              <li
                key={job.id}
                className="rounded-xl border border-[var(--border)] bg-[var(--card)]/40 p-4"
              >
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
                      onClick={() =>
                        void act(job.id, async () => {
                          await runCronJob(job.id);
                        })
                      }
                      className="inline-flex items-center gap-1 rounded-lg border border-[var(--border)] px-2.5 py-1 text-[12px] hover:bg-[var(--muted)]/50 disabled:opacity-50"
                    >
                      {busy ? (
                        <Loader2 size={12} className="animate-spin" />
                      ) : (
                        <Play size={12} />
                      )}
                      {t("Run now")}
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void act(job.id, async () => {
                          await patchCronJob(job.id, { enabled: !job.enabled });
                        })
                      }
                      className="rounded-lg border border-[var(--border)] px-2.5 py-1 text-[12px] hover:bg-[var(--muted)]/50 disabled:opacity-50"
                    >
                      {job.enabled ? t("Pause") : t("Resume")}
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        window.confirm(t("Delete this scheduled task?"))
                          ? void act(job.id, async () => {
                              await deleteCronJob(job.id);
                            })
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
                    <dt className="uppercase tracking-wide opacity-70">
                      {t("Schedule")}
                    </dt>
                    <dd className="mt-0.5 text-[var(--foreground)]">
                      {describeCronSchedule(job.schedule, locale)}
                    </dd>
                  </div>
                  <div>
                    <dt className="uppercase tracking-wide opacity-70">
                      {t("Next run")}
                    </dt>
                    <dd className="mt-0.5 text-[var(--foreground)]">
                      {formatCronInstant(job.state.next_run_at_ms, locale)}
                    </dd>
                  </div>
                  <div>
                    <dt className="uppercase tracking-wide opacity-70">
                      {t("Last run")}
                    </dt>
                    <dd className="mt-0.5 text-[var(--foreground)]">
                      {formatCronInstant(job.state.last_run_at_ms, locale)}
                      {job.state.last_status
                        ? ` · ${job.state.last_status}`
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
                        onChange={(event) =>
                          void act(job.id, async () => {
                            await patchCronJob(job.id, {
                              session_id: event.target.value,
                            });
                          })
                        }
                      >
                        <option value="">{t("Unbound")}</option>
                        {bound && !sessionTitle.has(bound) ? (
                          <option value={bound}>{bound}</option>
                        ) : null}
                        {sessions.map((session) => (
                          <option
                            key={session.session_id}
                            value={session.session_id}
                          >
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
          })}
        </ul>
      )}
    </div>
  );
}
