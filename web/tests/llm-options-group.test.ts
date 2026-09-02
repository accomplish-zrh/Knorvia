import test from "node:test";
import assert from "node:assert/strict";

import { groupLLMOptionsByProvider, type LLMOption } from "../lib/llm-options";

function option(partial: Partial<LLMOption> & Pick<LLMOption, "profile_id" | "model_id" | "model">): LLMOption {
  return {
    profile_name: partial.profile_name || partial.provider || "p",
    model_name: partial.model_name || partial.model,
    provider: partial.provider || "openai",
    provider_label: partial.provider_label,
    is_active_default: false,
    ...partial,
  };
}

test("groups configured models by provider/relay label", () => {
  const grouped = groupLLMOptionsByProvider([
    option({
      profile_id: "a",
      model_id: "m1",
      model: "gpt-4o",
      provider: "openai",
      provider_label: "OpenAI",
    }),
    option({
      profile_id: "b",
      model_id: "m2",
      model: "claude-sonnet",
      provider: "openrouter",
      provider_label: "OpenRouter",
    }),
    option({
      profile_id: "c",
      model_id: "m3",
      model: "gpt-4.1",
      provider: "openai",
      provider_label: "OpenAI",
    }),
  ]);
  assert.equal(grouped.length, 2);
  assert.equal(grouped[0].label, "OpenAI");
  assert.equal(grouped[0].options.length, 2);
  assert.equal(grouped[1].label, "OpenRouter");
  assert.equal(grouped[1].options[0].model, "claude-sonnet");
});
