/**
 * Named task-history views and return-to-context (B15).
 *
 * A view is a named filter combination (status, project, query, date range)
 * plus the browsing position (how many rows were expanded). Views are local
 * user configuration; applying one changes only the visible projection and
 * never restores a selection set, so a bulk operation can never silently run
 * against a restored list of ids.
 */

export type HistoryViewConfig = {
  id: string;
  name: string;
  filter: "all" | "running" | "attention" | "failed" | "archived";
  projectId: string;
  dateRange: "anytime" | "7d" | "30d";
  query: string;
  /** Browsing position to restore: expanded row count. */
  visible: number;
  createdAt: number;
  updatedAt: number;
};

export type HistoryLocation = {
  viewId: string | null;
  filter: HistoryViewConfig["filter"];
  projectId: string;
  dateRange: HistoryViewConfig["dateRange"];
  query: string;
  visible: number;
  anchor?: { threadId: string; offset: number };
  scrollTop?: number;
};

export const HISTORY_VIEWS_STORAGE_KEY = "knorvia-native-history-views";
export const HISTORY_LOCATION_STORAGE_KEY = "knorvia-native-history-location";
export const HISTORY_VIEWS_LIMIT = 30;
const MAX_NAME = 80;
const MAX_QUERY = 200;
const FILTERS = ["all", "running", "attention", "failed", "archived"];
const RANGES = ["anytime", "7d", "30d"];
export const HISTORY_VISIBLE_DEFAULT = 50;

const text = (value: unknown, max: number): value is string => typeof value === "string" && value.length <= max;

export function parseHistoryViews(raw: string | null | undefined): HistoryViewConfig[] {
  let parsed: unknown;
  try { parsed = raw ? JSON.parse(raw) : undefined; } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  const views: HistoryViewConfig[] = [];
  const ids = new Set<string>();
  for (const entry of parsed) {
    const item = entry as Partial<HistoryViewConfig> | null;
    if (!item || typeof item.id !== "string" || !/^[\w-]{1,64}$/.test(item.id)) continue;
    if (!text(item.name, MAX_NAME) || !item.name.trim()) continue;
    if (!text(item.query, MAX_QUERY)) continue;
    if (typeof item.filter !== "string" || !FILTERS.includes(item.filter)) continue;
    if (typeof item.dateRange !== "string" || !RANGES.includes(item.dateRange)) continue;
    if (ids.has(item.id)) continue;
    ids.add(item.id);
    views.push({
      id: item.id,
      name: item.name.trim(),
      filter: item.filter as HistoryViewConfig["filter"],
      projectId: typeof item.projectId === "string" && item.projectId ? item.projectId : "all",
      dateRange: item.dateRange as HistoryViewConfig["dateRange"],
      query: item.query,
      visible: Number.isInteger(item.visible) && item.visible! >= HISTORY_VISIBLE_DEFAULT && item.visible! <= 5000 ? item.visible! : HISTORY_VISIBLE_DEFAULT,
      createdAt: typeof item.createdAt === "number" ? item.createdAt : 0,
      updatedAt: typeof item.updatedAt === "number" ? item.updatedAt : Date.now(),
    });
    if (views.length >= HISTORY_VIEWS_LIMIT) break;
  }
  return views;
}

export function upsertHistoryView(views: HistoryViewConfig[], view: HistoryViewConfig): HistoryViewConfig[] {
  const rest = views.filter(item => item.id !== view.id);
  return [{ ...view, updatedAt: Date.now() }, ...rest].slice(0, HISTORY_VIEWS_LIMIT);
}

export function removeHistoryView(views: HistoryViewConfig[], id: string): HistoryViewConfig[] {
  return views.filter(item => item.id !== id);
}

/** URL integration: the view id is the only thing the URL carries. */
export function readViewIdFromSearch(search: string): string | null {
  try {
    const values = new URLSearchParams(search).getAll("view");
    const value = values.length === 1 ? values[0] : null;
    return value && /^[\w-]{1,64}$/.test(value) ? value : null;
  } catch { return null; }
}

export function viewSearch(viewId: string | null): string {
  return viewId ? `?view=${encodeURIComponent(viewId)}` : "";
}

export function parseLocation(raw: string | null | undefined): HistoryLocation | null {
  let parsed: unknown;
  try { parsed = raw ? JSON.parse(raw) : null; } catch { return null; }
  const item = parsed as Partial<HistoryLocation> | null;
  if (!item || typeof item !== "object") return null;
  if (typeof item.filter !== "string" || !FILTERS.includes(item.filter)) return null;
  if (typeof item.dateRange !== "string" || !RANGES.includes(item.dateRange)) return null;
  return {
    viewId: typeof item.viewId === "string" && /^[\w-]{1,64}$/.test(item.viewId) ? item.viewId : null,
    filter: item.filter as HistoryLocation["filter"],
    projectId: typeof item.projectId === "string" && item.projectId ? item.projectId : "all",
    dateRange: item.dateRange as HistoryLocation["dateRange"],
    query: text(item.query, MAX_QUERY) ? item.query : "",
    visible: Number.isInteger(item.visible) && item.visible! >= HISTORY_VISIBLE_DEFAULT && item.visible! <= 5000 ? item.visible! : HISTORY_VISIBLE_DEFAULT,
    ...(item.anchor && text(item.anchor.threadId, 200) && Number.isFinite(item.anchor.offset) && Math.abs(item.anchor.offset) < 100_000 ? { anchor: { threadId: item.anchor.threadId, offset: item.anchor.offset } } : {}),
    ...(typeof item.scrollTop === "number" && Number.isFinite(item.scrollTop) && item.scrollTop >= 0 && item.scrollTop < 100_000_000 ? { scrollTop: item.scrollTop } : {}),
  };
}

export function serializeLocation(location: HistoryLocation): string {
  return JSON.stringify(location);
}

// --- storage ------------------------------------------------------------------

const hasStorage = () => typeof localStorage !== "undefined";

export function loadHistoryViews(): HistoryViewConfig[] {
  if (!hasStorage()) return [];
  try { return parseHistoryViews(localStorage.getItem(HISTORY_VIEWS_STORAGE_KEY)); } catch { return []; }
}

export function persistHistoryViews(views: HistoryViewConfig[]): boolean {
  if (!hasStorage()) return false;
  try { localStorage.setItem(HISTORY_VIEWS_STORAGE_KEY, JSON.stringify(views)); return true; } catch { return false; }
}

export function loadLastLocation(): HistoryLocation | null {
  if (!hasStorage()) return null;
  try { return parseLocation(typeof sessionStorage !== "undefined" ? sessionStorage.getItem(HISTORY_LOCATION_STORAGE_KEY) ?? localStorage.getItem(HISTORY_LOCATION_STORAGE_KEY) : localStorage.getItem(HISTORY_LOCATION_STORAGE_KEY)); } catch { return null; }
}

export function persistLastLocation(location: HistoryLocation): void {
  if (!hasStorage()) return;
  try { (typeof sessionStorage !== "undefined" ? sessionStorage : localStorage).setItem(HISTORY_LOCATION_STORAGE_KEY, serializeLocation(location)); } catch { /* optional */ }
}
