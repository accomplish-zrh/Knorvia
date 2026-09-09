import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  PROVIDER_PRESETS,
  cacheSemanticsForPresetModel,
  effortsForPresetModel,
  presetById,
  quotaLabel,
  type ProviderPreset,
} from "../lib/provider-presets";

const zh = (text: string) => text;
const en = (_zh: string, en: string) => en;

test("presets carry connection defaults without keys and honest quota labels", () => {
  assert.ok(PROVIDER_PRESETS.length >= 5, "a usable starter catalog exists");
  for (const preset of PROVIDER_PRESETS) {
    assert.ok(preset.baseUrl.startsWith("http"));
    assert.ok(["responses", "chat-completions", "anthropic-messages"].includes(preset.protocol));
    assert.ok(preset.models.length > 0);
    // A preset is a connection default, never a credential.
    assert.equal(JSON.stringify(preset).includes("apiKey"), false);
    assert.equal(JSON.stringify(preset).includes("sk-"), false);
    const text = quotaLabel(preset, zh);
    if (preset.quota === "api") {
      assert.ok(text.includes("按量"), "API presets are labeled metered, not subscription");
    }
    if (preset.keyless) assert.equal(preset.quota, "local", "keyless presets are local services");
  }
  assert.equal(
    PROVIDER_PRESETS.some(preset => preset.models.some(model => model.promptCache === "read-write")),
    true,
    "an Anthropic-style read-write cache preset exists for ledger alignment"
  );
});

test("reasoning efforts stay within the gateway vocabulary and unknown stays null", () => {
  const openai = presetById("openai");
  assert.ok(openai);
  assert.deepEqual(effortsForPresetModel(openai, "gpt-5.2"), ["minimal", "low", "medium", "high"]);
  // Not inventing strengths is the contract: unknown → null, never ultra.
  assert.equal(effortsForPresetModel(openai, "gpt-4o-mini"), null);
  assert.equal(effortsForPresetModel(presetById("openrouter") as ProviderPreset, "openrouter/auto"), null);
  for (const preset of PROVIDER_PRESETS) {
    for (const model of preset.models) {
      for (const effort of model.reasoningEfforts ?? []) {
        assert.ok(
          ["minimal", "low", "medium", "high", "xhigh"].includes(effort),
          `${preset.id}/${model.model} lists unknown effort ${effort}`
        );
      }
    }
  }
});

test("cache semantics default to unknown, never a fake zero", () => {
  const anthropic = presetById("anthropic");
  assert.ok(anthropic);
  assert.equal(cacheSemanticsForPresetModel(anthropic, "claude-sonnet-4-5"), "read-write");
  const openai = presetById("openai");
  assert.ok(openai);
  assert.equal(cacheSemanticsForPresetModel(openai, "gpt-4.1"), "subset");
  assert.equal(cacheSemanticsForPresetModel(openai, "not-a-model"), "unknown");
});

test("quota wording never claims subscription quota converts to API credit", () => {
  const source = readFileSync(path.resolve(process.cwd(), "lib/provider-presets.ts"), "utf8");
  assert.ok(!/订阅.{0,8}(等于|换算|通用\s*API)/.test(source));
  assert.ok(source.includes("非订阅额度"), "API presets explicitly disclaim subscription quota");
});
