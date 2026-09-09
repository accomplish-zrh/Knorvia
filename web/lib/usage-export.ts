/** CSV rows preserve cache presence and the exact scope of the summary. */
export type UsageExportRow = {
  model: string; providerId: string; day: string; completeness: string; cacheKnown: boolean;
  cacheWriteKnown?: boolean;
  turns: number; inputTokens: number; cachedInputTokens: number; cacheWriteInputTokens: number;
  outputTokens: number; reasoningOutputTokens: number; totalTokens: number;
};

export function usageCsv(rows: UsageExportRow[], filters: Record<string, unknown> = {}): string {
  const cell = (value: unknown) => {
    const text = value == null ? "" : String(value);
    return `"${(/^[=+@\-\t\r\n]/.test(text) ? "'" + text : text).replace(/"/g, '""')}"`;
  };
  const scope = ["botId", "conversationId", "conversationKind", "threadId", "workspaceId", "fromMs", "toMs"];
  const lines: unknown[][] = [["Provider", "Model", "UTC date", "Usage status", "Cache status", "Turns", "Input tokens (includes cache)", "Uncached input", "Cache read", "Cache write", "Output tokens (includes reasoning)", "Reasoning output", "Total tokens", ...scope]];
  for (const row of rows) {
    const known = row.completeness !== "unknown";
    lines.push([row.providerId, row.model, row.day, row.completeness, row.cacheKnown ? (row.cacheWriteKnown === false ? "read-reported/write-unknown" : "reported") : "unknown", row.turns,
      known ? row.inputTokens : "", known && row.cacheKnown && row.cacheWriteKnown !== false ? Math.max(0, row.inputTokens - row.cachedInputTokens - row.cacheWriteInputTokens) : "",
      row.cacheKnown ? row.cachedInputTokens : "", (row.cacheWriteKnown ?? row.cacheKnown) ? row.cacheWriteInputTokens : "",
      known ? row.outputTokens : "", known ? row.reasoningOutputTokens : "", known ? row.totalTokens : "", ...scope.map(key => filters[key])]);
  }
  return "\ufeff" + lines.map(row => row.map(cell).join(",")).join("\r\n");
}
