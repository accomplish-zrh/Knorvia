/**
 * Provider presets (route C, night shift 2026-09-08).
 *
 * Connection defaults + capability hints only: presets never carry API
 * keys, never trigger paid verification, and never promise subscription
 * quota as generic API credit. Model lists are short, real catalogs —
 * the `reasoningEfforts` arrays come from each provider's documented
 * strength vocabulary; an absent array means "unknown / decided
 * elsewhere" and the UI must not offer strength controls that would
 * send unsupported fields (the gateway drops those defensively too).
 */

export type ProviderProtocol = "responses" | "chat-completions" | "anthropic-messages";

/** Cache accounting semantics, aligned with the usage ledger. */
export type PromptCacheSemantics =
  /** cached tokens are a subset of input tokens (OpenAI-style). */
  | "subset"
  /** separate cache read + write counters; raw input excludes them (Anthropic-style). */
  | "read-write"
  | "none"
  | "unknown";

export interface PresetModel {
  model: string;
  /** Documented strength vocabulary; omit when unknown — never invent. */
  reasoningEfforts?: string[];
  promptCache?: PromptCacheSemantics;
  note?: { zh: string; en: string };
}

export interface ProviderPreset {
  id: string;
  label: { zh: string; en: string };
  baseUrl: string;
  protocol: ProviderProtocol;
  docsUrl?: string;
  /** Billing kind: presets here are metered API or local; account
   * (subscription) connections live in the auth-link registry instead. */
  quota: "api" | "local";
  keyless?: boolean;
  models: PresetModel[];
}

export const REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh"] as const;

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "openai",
    label: { zh: "OpenAI", en: "OpenAI" },
    baseUrl: "https://api.openai.com/v1",
    protocol: "responses",
    docsUrl: "https://developers.openai.com/api/docs/guides/prompt-caching",
    quota: "api",
    models: [
      { model: "gpt-5.2", reasoningEfforts: ["minimal", "low", "medium", "high"], promptCache: "subset" },
      { model: "gpt-5-mini", reasoningEfforts: ["minimal", "low", "medium", "high"], promptCache: "subset" },
      { model: "o4-mini", reasoningEfforts: ["low", "medium", "high"], promptCache: "subset" },
      { model: "gpt-4.1", promptCache: "subset" },
      { model: "gpt-4o-mini", promptCache: "subset" },
    ],
  },
  {
    id: "anthropic",
    label: { zh: "Anthropic Claude", en: "Anthropic Claude" },
    baseUrl: "https://api.anthropic.com/v1",
    protocol: "anthropic-messages",
    docsUrl: "https://platform.claude.com/docs/en/build-with-claude/prompt-caching",
    quota: "api",
    models: [
      { model: "claude-sonnet-4-5", reasoningEfforts: ["low", "medium", "high"], promptCache: "read-write" },
      { model: "claude-opus-4-1", reasoningEfforts: ["low", "medium", "high"], promptCache: "read-write" },
      { model: "claude-haiku-4-5", promptCache: "read-write" },
    ],
  },
  {
    id: "gemini",
    label: { zh: "Google Gemini", en: "Google Gemini" },
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    protocol: "chat-completions",
    docsUrl: "https://ai.google.dev/gemini-api/docs/openai",
    quota: "api",
    models: [
      { model: "gemini-2.5-pro", promptCache: "unknown" },
      { model: "gemini-2.5-flash", promptCache: "unknown" },
    ],
  },
  {
    id: "deepseek",
    label: { zh: "DeepSeek", en: "DeepSeek" },
    baseUrl: "https://api.deepseek.com/v1",
    protocol: "chat-completions",
    docsUrl: "https://api-docs.deepseek.com/guides/reasoning_model",
    quota: "api",
    models: [
      { model: "deepseek-chat", promptCache: "subset" },
      { model: "deepseek-reasoner", promptCache: "subset" },
    ],
  },
  {
    id: "openrouter",
    label: { zh: "OpenRouter", en: "OpenRouter" },
    baseUrl: "https://openrouter.ai/api/v1",
    protocol: "chat-completions",
    docsUrl: "https://openrouter.ai/docs",
    quota: "api",
    models: [
      {
        model: "openrouter/auto",
        note: { zh: "聚合路由：模型能力以所选上游为准", en: "Aggregated routing: capabilities follow the chosen upstream" },
      },
    ],
  },
  {
    id: "ollama",
    label: { zh: "Ollama（本机）", en: "Ollama (local)" },
    baseUrl: "http://127.0.0.1:11434/v1",
    protocol: "chat-completions",
    docsUrl: "https://github.com/ollama/ollama/blob/main/docs/openai.md",
    quota: "local",
    keyless: true,
    models: [
      {
        model: "llama3.1",
        note: { zh: "本机模型：名称以 `ollama list` 为准", en: "Local models: use the names shown by `ollama list`" },
      },
    ],
  },
  {
    id: "lmstudio",
    label: { zh: "LM Studio（本机）", en: "LM Studio (local)" },
    baseUrl: "http://127.0.0.1:1234/v1",
    protocol: "chat-completions",
    docsUrl: "https://lmstudio.ai/docs/app/api",
    quota: "local",
    keyless: true,
    models: [
      {
        model: "local-model",
        note: { zh: "本机模型：名称以 LM Studio 服务器页为准", en: "Local models: use the names shown in the LM Studio server tab" },
      },
    ],
  },
  {
    id: "vllm",
    label: { zh: "vLLM（自托管）", en: "vLLM (self-hosted)" },
    baseUrl: "http://127.0.0.1:8000/v1",
    protocol: "chat-completions",
    docsUrl: "https://docs.vllm.ai/en/latest/serving/openai_compatible_server.html",
    quota: "local",
    keyless: true,
    models: [
      {
        model: "served-model",
        note: { zh: "以 vLLM 启动参数 --served-model-name 为准", en: "Use the name configured via --served-model-name" },
      },
    ],
  },
];

export function presetById(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find(preset => preset.id === id);
}

/**
 * Efforts a preset model supports, or `null` when unknown. `null` means
 * the UI shows no strength control (or a read-only "decided by the
 * provider" note) — it must not default to a value the model may reject.
 */
export function effortsForPresetModel(preset: ProviderPreset, model: string): string[] | null {
  const entry = preset.models.find(entry => entry.model === model);
  if (!entry || !entry.reasoningEfforts) return null;
  return entry.reasoningEfforts.filter(effort => (REASONING_EFFORTS as readonly string[]).includes(effort));
}

export function cacheSemanticsForPresetModel(preset: ProviderPreset, model: string): PromptCacheSemantics {
  return preset.models.find(entry => entry.model === model)?.promptCache ?? "unknown";
}

/** Quota wording kept honest: presets are API-metered or local, never a
 * ChatGPT/Claude subscription passthrough. */
export function quotaLabel(preset: ProviderPreset, t: (zh: string, en: string) => string): string {
  return preset.quota === "local"
    ? t("本机服务，不经外部计费", "Local service; no external billing")
    : t("API 按量计费（非订阅额度）", "Metered API (not subscription quota)");
}
