/**
 * Local workspace export/import (Obsidian / Cherry zip).
 *
 * Zip layout (also documented in knorvia/services/workspace_bundle.py):
 *   knorvia-workspace/
 *     manifest.json
 *     conversations/<session_id>.json
 *     notes/<notebook_id>.json
 *     outlines/<classroom_or_outline_id>.json
 *
 * Never packed: .env, secrets, API keys, credentials, settings with tokens.
 * Fully local — no cloud account.
 */

import { apiFetch, apiUrl } from "@/lib/api";

export const WORKSPACE_BUNDLE_VERSION = 1;
export const WORKSPACE_BUNDLE_ROOT = "knorvia-workspace";

export const WORKSPACE_SECRET_BASENAMES = [
  ".env",
  ".env.local",
  ".env.production",
  "credentials.json",
  "secrets.json",
  "api_keys.json",
] as const;

export function isWorkspaceSecretPath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/").toLowerCase();
  const base = normalized.split("/").pop() || "";
  if ((WORKSPACE_SECRET_BASENAMES as readonly string[]).includes(base)) {
    return true;
  }
  return /(^|\/)(\.env($|\.)|.*secret.*|.*credential.*|.*api[_-]?key.*|.*token.*)(\/|$)/i.test(
    normalized,
  );
}

export async function downloadWorkspaceBundle(): Promise<void> {
  const response = await apiFetch(apiUrl("/api/v1/workspace/export"), {
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error("Export failed (" + String(response.status) + ")");
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  const stamp = new Date().toISOString().slice(0, 10);
  anchor.href = url;
  anchor.download = "knorvia-workspace-" + stamp + ".zip";
  anchor.click();
  URL.revokeObjectURL(url);
}

export async function uploadWorkspaceBundle(file: File): Promise<{
  conversations: number;
  notes: number;
  outlines: number;
}> {
  const body = new FormData();
  body.append("file", file);
  const response = await apiFetch(apiUrl("/api/v1/workspace/import"), {
    method: "POST",
    body,
  });
  if (!response.ok) {
    let detail = String(response.status) + " " + response.statusText;
    try {
      const payload = await response.json();
      if (payload?.detail) detail = String(payload.detail);
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }
  return response.json();
}
