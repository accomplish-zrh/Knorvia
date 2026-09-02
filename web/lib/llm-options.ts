import { apiFetch, apiUrl } from "@/lib/api";
import { invalidateClientCache, withClientCache } from "@/lib/client-cache";
import type { LLMSelection } from "@/lib/unified-ws";

const LLM_OPTIONS_CACHE_KEY = "llm-options:list";

export interface LLMOption extends LLMSelection {
  profile_name: string;
  model_name: string;
  model: string;
  provider: string;
  /** Human-readable provider name from the registry ("OpenRouter"). */
  provider_label?: string;
  context_window?: number;
  is_active_default: boolean;
}

export interface LLMOptionsResponse {
  active: LLMSelection | null;
  options: LLMOption[];
}

export function llmSelectionKey(selection: LLMSelection | null | undefined) {
  if (!selection?.profile_id || !selection.model_id) return "";
  return `${selection.profile_id}:${selection.model_id}`;
}

export function sameLLMSelection(
  a: LLMSelection | null | undefined,
  b: LLMSelection | null | undefined,
) {
  return llmSelectionKey(a) === llmSelectionKey(b);
}

/** List the configured model profiles.
 *
 *  Cached so the many consumers that need the model list (composer, model
 *  picker, capability gate, partner forms) share one round-trip instead of
 *  each firing their own on mount. Editing a profile calls
 *  ``invalidateLLMOptionsCache``; pass ``force`` to bypass the cache. */
export async function listLLMOptions(options?: {
  force?: boolean;
}): Promise<LLMOptionsResponse> {
  return withClientCache<LLMOptionsResponse>(
    LLM_OPTIONS_CACHE_KEY,
    async () => {
      const response = await apiFetch(apiUrl("/api/v1/settings/llm-options"), {
        cache: "no-store",
      });
      if (!response.ok) {
        throw new Error(`Failed to load LLM options: ${response.status}`);
      }
      const data = (await response.json()) as LLMOptionsResponse;
      return {
        active: data.active ?? null,
        options: Array.isArray(data.options) ? data.options : [],
      };
    },
    { force: options?.force },
  );
}


export interface LLMProviderGroup {
  label: string;
  provider: string;
  options: LLMOption[];
}

/** Group configured models by provider/relay for the chat top-bar switcher. */
export function groupLLMOptionsByProvider(options: LLMOption[]): LLMProviderGroup[] {
  const order: string[] = [];
  const map = new Map<string, LLMProviderGroup>();
  for (const option of options) {
    const provider = option.provider || "custom";
    const label = option.provider_label || option.profile_name || provider || "LLM";
    const key = `${provider}::${label}`;
    if (!map.has(key)) {
      order.push(key);
      map.set(key, { label, provider, options: [] });
    }
    map.get(key)!.options.push(option);
  }
  return order.map((key) => map.get(key)!);
}

export function invalidateLLMOptionsCache(): void {
  invalidateClientCache(LLM_OPTIONS_CACHE_KEY);
}
