import { apiFetch, apiUrl } from "@/lib/api";

export type CronScheduleKind = "at" | "every" | "cron";

export type CronJob = {
  id: string;
  name: string;
  message: string;
  enabled: boolean;
  delete_after_run: boolean;
  created_at_ms: number;
  schedule: {
    kind: CronScheduleKind;
    at_ms: number | null;
    every_seconds: number | null;
    expr: string | null;
    tz: string | null;
  };
  owner: {
    kind: string;
    session_id: string;
    partner_id: string;
    language: string;
  };
  state: {
    next_run_at_ms: number | null;
    last_run_at_ms: number | null;
    last_status: string | null;
    last_error: string | null;
  };
};

export type CronWritePayload = {
  name?: string;
  message?: string;
  session_id?: string;
  language?: string;
  enabled?: boolean;
  at?: string;
  every_seconds?: number;
  cron_expr?: string;
  tz?: string;
};

async function expectJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const payload = (await response.json()) as { detail?: string };
      if (payload?.detail) detail = payload.detail;
    } catch {
      /* keep status */
    }
    throw new Error(detail);
  }
  return response.json() as Promise<T>;
}

export async function listCronJobs(): Promise<CronJob[]> {
  const payload = await expectJson<{ jobs: CronJob[] }>(
    await apiFetch(apiUrl("/api/v1/cron/jobs"), { cache: "no-store" }),
  );
  return payload.jobs ?? [];
}

export async function createCronJob(body: CronWritePayload): Promise<CronJob> {
  return expectJson(
    await apiFetch(apiUrl("/api/v1/cron/jobs"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

export async function patchCronJob(
  id: string,
  body: CronWritePayload,
): Promise<CronJob> {
  return expectJson(
    await apiFetch(apiUrl(`/api/v1/cron/jobs/${encodeURIComponent(id)}`), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

export async function runCronJob(id: string): Promise<CronJob> {
  return expectJson(
    await apiFetch(apiUrl(`/api/v1/cron/jobs/${encodeURIComponent(id)}/run`), {
      method: "POST",
    }),
  );
}

export async function deleteCronJob(id: string): Promise<void> {
  await expectJson(
    await apiFetch(apiUrl(`/api/v1/cron/jobs/${encodeURIComponent(id)}`), {
      method: "DELETE",
    }),
  );
}

export function describeCronSchedule(
  schedule: CronJob["schedule"],
  locale: string,
): string {
  if (schedule.kind === "at" && schedule.at_ms) {
    return new Date(schedule.at_ms).toLocaleString(locale);
  }
  if (schedule.kind === "every" && schedule.every_seconds) {
    const seconds = schedule.every_seconds;
    if (seconds % 3600 === 0) return `every ${seconds / 3600}h`;
    if (seconds % 60 === 0) return `every ${seconds / 60}m`;
    return `every ${seconds}s`;
  }
  if (schedule.kind === "cron" && schedule.expr) {
    return schedule.tz ? `${schedule.expr} (${schedule.tz})` : schedule.expr;
  }
  return schedule.kind;
}

export function formatCronInstant(
  ms: number | null | undefined,
  locale: string,
): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleString(locale);
}
