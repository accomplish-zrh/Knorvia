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
    run_history?: CronRunRecord[];
  };
};

export type CronRunRecord = {
  run_at_ms: number;
  status: "ok" | "error" | "skipped" | string;
  duration_ms: number;
  error: string | null;
};

/** One entry from the cross-job run journal (`GET /jobs/runs`). */
export type CronRunEntry = CronRunRecord & {
  job_id: string;
  job_name: string;
};

export type CronTemplate = {
  id: string;
  icon: string;
  title: string;
  description: string;
  message: string;
  schedule: {
    kind: CronScheduleKind;
    expr?: string | null;
    tz?: string | null;
    every_seconds?: number | null;
    at_ms?: number | null;
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

export async function listCronTemplates(
  language: string,
): Promise<CronTemplate[]> {
  const payload = await expectJson<{ templates: CronTemplate[] }>(
    await apiFetch(
      apiUrl(`/api/v1/cron/templates?language=${encodeURIComponent(language)}`),
      { cache: "no-store" },
    ),
  );
  return payload.templates ?? [];
}

export async function listCronRuns(limit = 200): Promise<CronRunEntry[]> {
  const payload = await expectJson<{ runs: CronRunEntry[] }>(
    await apiFetch(apiUrl(`/api/v1/cron/jobs/runs?limit=${limit}`), {
      cache: "no-store",
    }),
  );
  return payload.runs ?? [];
}

/** Translate a template's schedule into CronWritePayload fields. */
export function templateToCreatePayload(
  template: CronTemplate,
): CronWritePayload {
  const body: CronWritePayload = {
    name: template.title,
    message: template.message,
  };
  if (template.schedule.kind === "every" && template.schedule.every_seconds) {
    body.every_seconds = template.schedule.every_seconds;
  } else if (template.schedule.expr) {
    body.cron_expr = template.schedule.expr;
    if (template.schedule.tz) body.tz = template.schedule.tz;
  }
  return body;
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

const WEEKDAY_ZH = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const WEEKDAY_EN = [
  "Sundays",
  "Mondays",
  "Tuesdays",
  "Wednesdays",
  "Thursdays",
  "Fridays",
  "Saturdays",
];

/** Human summary of a cron expression, or null when it defies patterns. */
function describeCronExpression(
  expr: string,
  locale: string,
): string | null {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minute, hour, dom, month, dow] = fields;

  // Fixed daily/weekly times only: "30 8 * * *" / "0 9 * * 1-5" / "0 10 * * 1".
  if (!/^\d{1,2}$/.test(minute) || !/^\d{1,2}$/.test(hour)) return null;
  if (dom !== "*" || month !== "*") return null;
  const h = Number(hour);
  const m = Number(minute);
  if (h > 23 || m > 59) return null;
  const time = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  const isZh = locale.toLowerCase().startsWith("zh");

  if (dow === "*") {
    return isZh ? `每天 ${time}` : `Daily at ${time}`;
  }
  if (dow === "1-5") {
    return isZh ? `工作日 ${time}` : `Weekdays at ${time}`;
  }
  if (/^[0-6]$/.test(dow)) {
    return isZh ? `每${WEEKDAY_ZH[Number(dow)]} ${time}` : `Every ${WEEKDAY_EN[Number(dow)]} at ${time}`;
  }
  return null;
}

export function describeCronSchedule(
  schedule: CronJob["schedule"],
  locale: string,
): string {
  const isZh = locale.toLowerCase().startsWith("zh");
  if (schedule.kind === "at" && schedule.at_ms) {
    return new Date(schedule.at_ms).toLocaleString(locale);
  }
  if (schedule.kind === "every" && schedule.every_seconds) {
    const seconds = schedule.every_seconds;
    if (seconds % 3600 === 0) {
      return isZh
        ? `每 ${seconds / 3600} 小时`
        : `every ${seconds / 3600}h`;
    }
    if (seconds % 60 === 0) {
      return isZh ? `每 ${seconds / 60} 分钟` : `every ${seconds / 60}m`;
    }
    return isZh ? `每 ${seconds} 秒` : `every ${seconds}s`;
  }
  if (schedule.kind === "cron" && schedule.expr) {
    const base = describeCronExpression(schedule.expr, locale) ?? schedule.expr;
    const withTz = schedule.tz ? `${base} · ${schedule.tz}` : base;
    return withTz;
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

export function formatCronDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds - minutes * 60)}s`;
}
