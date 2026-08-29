import test from "node:test";
import assert from "node:assert/strict";

import {
  describeCronSchedule,
  formatCronDuration,
  listCronRuns,
  listCronTemplates,
  templateToCreatePayload,
  type CronTemplate,
} from "../lib/cron-api";

type Captured = { method: string; url: string };

function stubFetch(
  body: unknown,
  status = 200,
): { calls: Captured[]; restore: () => void } {
  const original = globalThis.fetch;
  const calls: Captured[] = [];
  (globalThis as { fetch: typeof fetch }).fetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    calls.push({ method: init?.method ?? "GET", url: String(input) });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  };
  return {
    calls,
    restore: () => {
      (globalThis as { fetch: typeof fetch }).fetch = original;
    },
  };
}

test("describeCronSchedule summarizes daily/weekly cron in both locales", () => {
  const schedule = {
    kind: "cron" as const,
    at_ms: null,
    every_seconds: null,
    expr: "30 8 * * *",
    tz: null,
  };
  assert.equal(describeCronSchedule(schedule, "en-US"), "Daily at 08:30");
  assert.equal(describeCronSchedule(schedule, "zh-CN"), "每天 08:30");

  const weekdays = { ...schedule, expr: "0 9 * * 1-5" };
  assert.equal(describeCronSchedule(weekdays, "en-US"), "Weekdays at 09:00");
  assert.equal(describeCronSchedule(weekdays, "zh-CN"), "工作日 09:00");

  const mondays = { ...schedule, expr: "0 10 * * 1" };
  assert.equal(
    describeCronSchedule(mondays, "en-US"),
    "Every Mondays at 10:00",
  );
  assert.equal(describeCronSchedule(mondays, "zh-CN"), "每周一 10:00");
});

test("describeCronSchedule falls back to the raw expression + timezone", () => {
  const exotic = {
    kind: "cron" as const,
    at_ms: null,
    every_seconds: null,
    expr: "*/15 9-17 * * 1,3,5",
    tz: "Asia/Shanghai",
  };
  assert.equal(
    describeCronSchedule(exotic, "zh-CN"),
    "*/15 9-17 * * 1,3,5 · Asia/Shanghai",
  );
});

test("describeCronSchedule localizes interval schedules", () => {
  const hours = {
    kind: "every" as const,
    at_ms: null,
    every_seconds: 3600,
    expr: null,
    tz: null,
  };
  assert.equal(describeCronSchedule(hours, "en-US"), "every 1h");
  assert.equal(describeCronSchedule(hours, "zh-CN"), "每 1 小时");

  const minutes = { ...hours, every_seconds: 90 * 60 };
  assert.equal(describeCronSchedule(minutes, "zh-CN"), "每 90 分钟");
});

test("templateToCreatePayload maps template schedules to create fields", () => {
  const cron: CronTemplate = {
    id: "t1",
    icon: "Newspaper",
    title: "Brief",
    description: "",
    message: "do it",
    schedule: { kind: "cron", expr: "30 8 * * *", tz: "UTC", every_seconds: null },
  };
  assert.deepEqual(templateToCreatePayload(cron), {
    name: "Brief",
    message: "do it",
    cron_expr: "30 8 * * *",
    tz: "UTC",
  });

  const interval: CronTemplate = {
    ...cron,
    schedule: { kind: "every", expr: null, tz: null, every_seconds: 1800 },
  };
  assert.deepEqual(templateToCreatePayload(interval), {
    name: "Brief",
    message: "do it",
    every_seconds: 1800,
  });
});

test("listCronRuns fetches the journal endpoint and unwraps runs", async () => {
  const runs = [
    { job_id: "a", job_name: "A", run_at_ms: 1, status: "ok", duration_ms: 2, error: null },
  ];
  const stub = stubFetch({ runs });
  try {
    assert.deepEqual(await listCronRuns(50), runs);
    assert.ok(stub.calls[0].url.includes("/api/v1/cron/jobs/runs?limit=50"));
  } finally {
    stub.restore();
  }
});

test("listCronTemplates forwards the UI language", async () => {
  const stub = stubFetch({
    templates: [{ id: "t", icon: "Eye", title: "", description: "", message: "", schedule: {} }],
  });
  try {
    await listCronTemplates("zh");
    assert.ok(stub.calls[0].url.includes("/api/v1/cron/templates?language=zh"));
  } finally {
    stub.restore();
  }
});

test("formatCronDuration renders ms/seconds/minutes compactly", () => {
  assert.equal(formatCronDuration(250), "250ms");
  assert.equal(formatCronDuration(1200), "1.2s");
  assert.equal(formatCronDuration(45_000), "45s");
  assert.equal(formatCronDuration(95_000), "1m 35s");
});
