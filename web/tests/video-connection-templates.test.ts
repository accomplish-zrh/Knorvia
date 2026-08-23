import test from "node:test";
import assert from "node:assert/strict";

import {
  VIDEO_CONNECTION_TEMPLATES,
  type VideoConnectionTemplate,
} from "../lib/settings/video-connection-templates";

// C7 preset connection templates: the settings videogen form lets a brand-new
// user fill base URL + protocol + recommended model rows from these five
// entries. The table is static data, so its shape is the whole contract.

const TEMPLATES: VideoConnectionTemplate[] = VIDEO_CONNECTION_TEMPLATES;

test("exactly five connection templates ship", () => {
  assert.equal(TEMPLATES.length, 5);
});

test("template ids are unique and non-empty", () => {
  const ids = TEMPLATES.map((template) => template.id);
  for (const id of ids) assert.ok(typeof id === "string" && id.length > 0, `bad id: ${id}`);
  assert.deepEqual(ids, [...new Set(ids)]);
});

test("every base URL is a valid https URL", () => {
  for (const template of TEMPLATES) {
    const parsed = new URL(template.baseUrl);
    assert.equal(
      parsed.protocol,
      "https:",
      `${template.id}: expected https base URL, got ${template.baseUrl}`,
    );
  }
});

test("each template recommends at least one model with a non-empty model id", () => {
  for (const template of TEMPLATES) {
    assert.ok(
      Array.isArray(template.models) && template.models.length >= 1,
      `${template.id}: expected at least one recommended model row`,
    );
    for (const row of template.models) {
      assert.ok(
        typeof row.modelId === "string" && row.modelId.trim().length > 0,
        `${template.id}: empty modelId in recommended row`,
      );
    }
  }
});

test("auth guides exist in both english and chinese", () => {
  for (const template of TEMPLATES) {
    assert.ok(
      typeof template.authGuide?.en === "string" && template.authGuide.en.trim().length > 0,
      `${template.id}: missing english auth guide`,
    );
    assert.ok(
      typeof template.authGuide?.zh === "string" && template.authGuide.zh.trim().length > 0,
      `${template.id}: missing chinese auth guide`,
    );
  }
});

test("labels and adapters are non-empty strings", () => {
  for (const template of TEMPLATES) {
    assert.ok(
      typeof template.label === "string" && template.label.trim().length > 0,
      `${template.id}: missing label`,
    );
    assert.ok(
      typeof template.adapter === "string" && template.adapter.trim().length > 0,
      `${template.id}: missing adapter`,
    );
  }
});

test("referenced preset ids, when present, are strings", () => {
  // presetId is optional and intentionally not validated against the backend
  // preset table here — the editor applies it only when the preset shows up in
  // /api/v1/video-studio/capability-presets, so a not-yet-landed id is inert.
  for (const template of TEMPLATES) {
    for (const row of template.models) {
      if (row.presetId !== undefined) {
        assert.ok(
          typeof row.presetId === "string" && row.presetId.length > 0,
          `${template.id}: presetId must be a non-empty string when given`,
        );
      }
    }
  }
});

// Mirrors VIDEOGEN_ADAPTERS in knorvia/services/config/provider_runtime.py.
// Keep both lists in sync: a template pointing at an unregistered adapter
// would save model rows the backend can never resolve.
const BACKEND_VIDEOGEN_ADAPTERS = new Set([
  "async_task",
  "openai_videos",
  "volcengine_async_task",
  "kling_async_task",
  "wan_async_task",
  "hailuo_async_task",
]);

test("every template adapter exists in the backend adapter registry", () => {
  for (const template of TEMPLATES) {
    assert.ok(
      BACKEND_VIDEOGEN_ADAPTERS.has(template.adapter),
      `${template.id}: adapter "${template.adapter}" is not registered in VIDEOGEN_ADAPTERS`,
    );
  }
});

test("kling, dashscope and minimax templates use their dedicated adapters", () => {
  // C7+C2/C3 integration: the dedicated vendor adapters landed, so these
  // templates must fill the real protocol keys, not the generic placeholder.
  const byId = new Map(TEMPLATES.map(template => [template.id, template]));
  assert.equal(byId.get("kling")?.adapter, "kling_async_task");
  assert.equal(byId.get("dashscope-wan")?.adapter, "wan_async_task");
  assert.equal(byId.get("minimax")?.adapter, "hailuo_async_task");
});

test("dedicated-adapter templates backfill their capability preset ids", () => {
  const byId = new Map(TEMPLATES.map(template => [template.id, template]));
  for (const row of byId.get("kling")?.models ?? []) {
    assert.equal(row.presetId, "kling-2.x-like", `kling/${row.modelId}`);
  }
  for (const row of byId.get("dashscope-wan")?.models ?? []) {
    assert.equal(row.presetId, "wan-2.x-like", `dashscope-wan/${row.modelId}`);
  }
  const hailuoH3 = byId
    .get("minimax")
    ?.models.find(row => row.modelId === "MiniMax-Hailuo-H3");
  assert.equal(hailuoH3?.presetId, "hailuo-h3-like");
});
