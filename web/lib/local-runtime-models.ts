import type { LLMOption } from "@/lib/llm-options";

export const LOCAL_OLLAMA_PROFILE_ID = "__local_ollama";
export const LOCAL_LMSTUDIO_PROFILE_ID = "__local_lmstudio";

export const LOCAL_OLLAMA_PROBE = "http://127.0.0.1:11434/api/ps";
export const LOCAL_LMSTUDIO_PROBE = "http://127.0.0.1:1234/api/v0/models";
export const LOCAL_LMSTUDIO_FALLBACK = "http://127.0.0.1:1234/v1/models";

const PROBE_TIMEOUT_MS = 400;

export function isLocalRuntimeSelection(selection: {
  profile_id?: string;
} | null | undefined): boolean {
  const id = selection?.profile_id || "";
  return id === LOCAL_OLLAMA_PROFILE_ID || id === LOCAL_LMSTUDIO_PROFILE_ID;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function modelNameFrom(entry: unknown): string {
  const rec = asRecord(entry);
  if (!rec) return "";
  for (const key of ["name", "model", "id"]) {
    const raw = rec[key];
    if (typeof raw === "string" && raw.trim()) return raw.trim();
  }
  return "";
}

/** Ollama `/api/ps` — currently loaded (running) models only. */
export function parseOllamaLoadedModels(payload: unknown): string[] {
  const rec = asRecord(payload);
  const models = rec?.models;
  if (!Array.isArray(models)) return [];
  const names: string[] = [];
  const seen = new Set<string>();
  for (const item of models) {
    const name = modelNameFrom(item);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

function isLoadedState(state: unknown): boolean {
  const raw = String(state || "").toLowerCase().trim();
  if (!raw) return true;
  if (raw.includes("unload") || raw.startsWith("not-") || raw === "not-loaded") return false;
  return raw === "loaded" || raw === "idle" || raw === "loading";
}

/** LM Studio `/api/v0/models` or OpenAI-compat `/v1/models`. */
export function parseLmStudioLoadedModels(payload: unknown): string[] {
  const rec = asRecord(payload);
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray(rec?.data)
      ? rec!.data
      : Array.isArray(rec?.models)
        ? rec!.models
        : [];
  const names: string[] = [];
  const seen = new Set<string>();
  for (const item of rows) {
    const row = asRecord(item);
    if (!row) continue;
    if ("state" in row && !isLoadedState(row.state)) continue;
    if (row.loaded === false) continue;
    const name = modelNameFrom(row);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

export function localRuntimeOption(
  source: "ollama" | "lm_studio",
  model: string,
): LLMOption {
  const ollama = source === "ollama";
  return {
    profile_id: ollama ? LOCAL_OLLAMA_PROFILE_ID : LOCAL_LMSTUDIO_PROFILE_ID,
    model_id: model,
    profile_name: ollama ? "Ollama" : "LM Studio",
    model_name: model,
    model,
    provider: ollama ? "ollama" : "lm_studio",
    provider_label: ollama ? "Ollama" : "LM Studio",
    is_active_default: false,
  };
}

export async function quietJsonGet(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<unknown | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      signal: controller.signal,
      cache: "no-store",
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Probe loopback runtimes. Quiet when the port is closed. Never downloads. */
export async function probeLocalRuntimeModels(
  fetchImpl: typeof fetch = fetch,
): Promise<LLMOption[]> {
  const options: LLMOption[] = [];
  const ollama = await quietJsonGet(LOCAL_OLLAMA_PROBE, fetchImpl);
  for (const name of parseOllamaLoadedModels(ollama)) {
    options.push(localRuntimeOption("ollama", name));
  }
  let lm = await quietJsonGet(LOCAL_LMSTUDIO_PROBE, fetchImpl);
  if (lm == null) {
    lm = await quietJsonGet(LOCAL_LMSTUDIO_FALLBACK, fetchImpl);
  }
  for (const name of parseLmStudioLoadedModels(lm)) {
    options.push(localRuntimeOption("lm_studio", name));
  }
  return options;
}

export function mergeLocalRuntimeOptions(
  configured: LLMOption[],
  local: LLMOption[],
): LLMOption[] {
  if (!local.length) return configured;
  const seen = new Set(
    configured.map((item) => `${item.profile_id}:${item.model_id}`),
  );
  const extra: LLMOption[] = [];
  for (const item of local) {
    const key = `${item.profile_id}:${item.model_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    extra.push(item);
  }
  return extra.length ? [...configured, ...extra] : configured;
}
