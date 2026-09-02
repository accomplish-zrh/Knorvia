import test from "node:test";
import assert from "node:assert/strict";

import {
  LOCAL_LMSTUDIO_PROFILE_ID,
  LOCAL_OLLAMA_PROFILE_ID,
  mergeLocalRuntimeOptions,
  parseLmStudioLoadedModels,
  parseOllamaLoadedModels,
  probeLocalRuntimeModels,
  localRuntimeOption,
} from "../lib/local-runtime-models";
import type { LLMOption } from "../lib/llm-options";

test("parses Ollama /api/ps running models", () => {
  assert.deepEqual(
    parseOllamaLoadedModels({
      models: [{ name: "llama3.2:latest" }, { name: "llama3.2:latest" }, { model: "qwen2.5" }],
    }),
    ["llama3.2:latest", "qwen2.5"],
  );
});

test("parses LM Studio loaded rows and skips unloaded", () => {
  assert.deepEqual(
    parseLmStudioLoadedModels({
      data: [
        { id: "gemma-2-9b", state: "loaded" },
        { id: "other", state: "not-loaded" },
        { id: "phi-3", loaded: true },
      ],
    }),
    ["gemma-2-9b", "phi-3"],
  );
});

test("closed ports stay quiet and return no options", async () => {
  const fetchImpl = async () => {
    throw new TypeError("Failed to fetch");
  };
  const found = await probeLocalRuntimeModels(fetchImpl as unknown as typeof fetch);
  assert.deepEqual(found, []);
});

test("merges loaded locals into the existing switcher catalog", () => {
  const configured: LLMOption[] = [
    {
      profile_id: "p1",
      model_id: "m1",
      profile_name: "OpenAI",
      model_name: "gpt-4o",
      model: "gpt-4o",
      provider: "openai",
      is_active_default: true,
    },
  ];
  const merged = mergeLocalRuntimeOptions(configured, [
    localRuntimeOption("ollama", "llama3.2"),
  ]);
  assert.equal(merged.length, 2);
  assert.equal(merged[1].profile_id, LOCAL_OLLAMA_PROFILE_ID);
  assert.equal(merged[1].model_id, "llama3.2");
  assert.equal(merged[1].provider, "ollama");
  assert.equal(LOCAL_LMSTUDIO_PROFILE_ID.startsWith("__local_"), true);
});
