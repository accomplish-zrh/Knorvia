export type ProjectScope = { workspaceId?: string; threadId?: string };
export type ScopeLocation = { id: string; cwd: string };
export type ProjectEntry = { name: string; path: string; kind: "file" | "directory" | "symlink"; size?: number; modifiedAt?: string };
export type DirectoryPage = { workspace: ScopeLocation; path: string; entries: ProjectEntry[]; nextCursor?: string | null; truncated: boolean };
export type ProjectFile = { workspace: ScopeLocation; path: string; kind: "text" | "binary"; size: number; content?: string; truncated: boolean; nextOffset?: number };
export type GitFile = { path: string; status: string; oldPath?: string };
export type GitStatus = { workspace: ScopeLocation; available: boolean; root?: string; branch?: string; head?: string; staged: GitFile[]; unstaged: GitFile[]; untracked: GitFile[]; conflicts: GitFile[]; clean: boolean };
export type GitDiff = { workspace: ScopeLocation; available: boolean; path?: string; staged: boolean; diff: string; size: number; truncated: boolean; untracked?: boolean; binary?: boolean };
export type DiffLine = { kind: "meta" | "hunk" | "add" | "remove" | "context"; text: string; before?: number; after?: number };

/** Preserve file headers and no-newline markers without counting them as edits. */
export function parseUnifiedDiff(diff: string): DiffLine[] {
  let before = 0, after = 0, inHunk = false;
  const source = diff.split("\n");
  if (source.at(-1) === "") source.pop();
  return source.map(text => {
    if (text.startsWith("diff --git ")) { inHunk = false; return { kind: "meta", text }; }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) { before = Number(hunk[1]); after = Number(hunk[2]); inHunk = true; return { kind: "hunk", text }; }
    if (inHunk && text.startsWith("+")) return { kind: "add", text: text.slice(1), after: after++ };
    if (inHunk && text.startsWith("-")) return { kind: "remove", text: text.slice(1), before: before++ };
    if (inHunk && text.startsWith(" ")) return { kind: "context", text: text.slice(1), before: before++, after: after++ };
    return { kind: "meta", text };
  });
}

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function appendFileReferences(draft: string, paths: string[]): string {
  return [draft.trimEnd(), ...paths.map(path => `@${JSON.stringify(path)}`)].filter(Boolean).join("\n");
}

// --- project search (P01) -----------------------------------------------------

export type ProjectSearchMode = "paths" | "content" | "both";
export type ProjectSearchMatch = { path: string; name: string; kind: "file" | "symlink"; line?: number; column?: number; snippet?: string; matchCount?: number };
export type ProjectSearchCoverage = {
  scannedFiles: number; scannedDirectories: number; matchedFiles: number; skippedBinary: number;
  skippedLarge: number; skippedSymlink: number; ignoredEntries: number; unreadable: number;
  bytesScanned: number; otherEntries: number;
};
export type ProjectSearchPage = {
  workspace: ScopeLocation; searchId: string;
  query: { text: string; mode: ProjectSearchMode; caseSensitive: boolean };
  matches: ProjectSearchMatch[];
  page: { index: number; nextCursor?: string | null; done: boolean };
  coverage: ProjectSearchCoverage; matchedTotal: number; matchedLimitReached: boolean;
};
export type SearchQueryKey = { workspaceId?: string; threadId?: string; text: string; mode: ProjectSearchMode; caseSensitive: boolean };

/** A running search is only valid while every parameter that defines it stays put. */
export function searchQueryChanged(a: SearchQueryKey | undefined, b: SearchQueryKey): boolean {
  if (!a) return true;
  return a.workspaceId !== b.workspaceId || a.threadId !== b.threadId || a.text !== b.text
    || a.mode !== b.mode || a.caseSensitive !== b.caseSensitive;
}

/**
 * Append one server page to the displayed rows, dropping duplicates and
 * keeping the client-side list bounded: beyond `cap` rows we keep counting
 * matches but stop growing the DOM and report how many rows were dropped.
 */
export function appendSearchPage(rows: ProjectSearchMatch[], page: ProjectSearchPage, cap = 300): { rows: ProjectSearchMatch[]; dropped: number; total: number } {
  const seen = new Set(rows.map(row => `${row.path}:${row.line ?? ""}:${row.column ?? ""}`));
  const merged = [...rows];
  let dropped = 0;
  for (const match of page.matches) {
    const key = `${match.path}:${match.line ?? ""}:${match.column ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (merged.length >= cap) { dropped += 1; continue; }
    merged.push(match);
  }
  return { rows: merged, dropped, total: page.matchedTotal ?? merged.length + dropped };
}

/** A zero-result answer may only be called "no matches" once the scan is complete. */
export function searchCoversEverything(done: boolean, limitReached: boolean): boolean {
  return done || limitReached;
}

// --- structured project task context (B04) -----------------------------------

export const PROJECT_CONTEXT_LIMIT = 12;
export type ProjectContextMap = Record<string, string[]>;
export const PROJECT_CONTEXT_KEY = "knorvia-native-project-context";

const contextPath = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 1024;

/** Validate an untrusted stored map; per-project path lists, deduped, capped. */
export function parseProjectContexts(raw: string | null | undefined): ProjectContextMap {
  const result: ProjectContextMap = {};
  let parsed: unknown;
  try { parsed = raw ? JSON.parse(raw) : undefined; } catch { return result; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return result;
  for (const [projectId, list] of Object.entries(parsed as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue;
    const paths: string[] = [];
    for (const item of list) if (contextPath(item) && !paths.includes(item)) paths.push(item);
    if (paths.length) result[projectId] = paths.slice(-PROJECT_CONTEXT_LIMIT);
  }
  return result;
}

/** Add one file to a project's context: dedupe by path, cap the list. */
export function withProjectContextFile(map: ProjectContextMap, projectId: string, path: string): ProjectContextMap {
  if (!contextPath(path)) return map;
  const existing = Array.isArray(map[projectId]) ? map[projectId] : [];
  const next = existing.includes(path) ? existing : [...existing, path].slice(-PROJECT_CONTEXT_LIMIT);
  return { ...map, [projectId]: next };
}

/** Remove exactly the given paths from a project's context. */
export function withoutProjectContextFiles(map: ProjectContextMap, projectId: string, paths: string[]): ProjectContextMap {
  const drop = new Set(paths);
  const existing = Array.isArray(map[projectId]) ? map[projectId] : [];
  const next = existing.filter(path => !drop.has(path));
  const rest = { ...map };
  if (next.length) rest[projectId] = next; else delete rest[projectId];
  return rest;
}

const hasStorage = () => typeof localStorage !== "undefined";

function loadContexts(): ProjectContextMap {
  if (!hasStorage()) return {};
  try { return parseProjectContexts(localStorage.getItem(PROJECT_CONTEXT_KEY)); } catch { return {}; }
}

function saveContexts(map: ProjectContextMap) {
  if (!hasStorage()) return;
  try { localStorage.setItem(PROJECT_CONTEXT_KEY, JSON.stringify(map)); } catch { /* optional draft storage */ }
}

export function readProjectContextFiles(projectId: string): string[] {
  return loadContexts()[projectId] ?? [];
}

/** Structured add that survives reloads; returns the updated list. */
export function addProjectContextFile(projectId: string, path: string): string[] {
  const map = withProjectContextFile(loadContexts(), projectId, path);
  saveContexts(map);
  return map[projectId] ?? [];
}

/** Structured cleanup after a send: only the confirmed paths disappear. */
export function removeProjectContextFiles(projectId: string, paths: string[]): void {
  if (!paths.length) return;
  saveContexts(withoutProjectContextFiles(loadContexts(), projectId, paths));
}

// --- bounded current-directory scan (B08) ------------------------------------

/**
 * Merge a continuation page into the loaded directory ONLY when it is the
 * same scope: same relative path AND same workspace. Cross-project folders
 * with identical relative paths can never mix, and a stale page from a
 * previous scope is reported as a mismatch instead of being merged.
 */
export function mergeDirectoryPage(current: DirectoryPage, page: DirectoryPage): DirectoryPage | null {
  if (current.path !== page.path || current.workspace?.id !== page.workspace?.id) return null;
  const entries = [...new Map([...current.entries, ...page.entries].map(entry => [entry.path, entry])).values()];
  return { ...page, entries };
}

export type DirectoryScanOptions = {
  /** Hard bound per "keep scanning" run; never an unbounded enumeration. */
  maxPages?: number;
  isCancelled?: () => boolean;
  /** Stop as soon as any new entry matches (e.g. the active name filter). */
  matches?: (entry: ProjectEntry) => boolean;
};

export type DirectoryScanOutcome = {
  directory: DirectoryPage | null;
  /** A new entry satisfied the predicate. */
  matched: boolean;
  /** The caller cancelled before the bound or exhaustion. */
  cancelled: boolean;
  /** A page arrived from another scope; the caller's directory was kept. */
  staleScope: boolean;
};

/**
 * Continue a directory walk page by page under a fixed page bound. An empty
 * page or a cancelled run is never interpreted as "the directory has no such
 * entry": `matched`/`cancelled`/`directory.nextCursor` say exactly what happened.
 */
export async function scanDirectoryPages(
  fetchPage: (cursor: string) => Promise<DirectoryPage>,
  current: DirectoryPage,
  options: DirectoryScanOptions = {},
): Promise<DirectoryScanOutcome> {
  const maxPages = Math.max(1, options.maxPages ?? 10);
  let directory = current;
  for (let page = 0; page < maxPages; page += 1) {
    if (options.isCancelled?.()) return { directory, matched: false, cancelled: true, staleScope: false };
    const cursor = directory.nextCursor;
    if (!cursor) return { directory, matched: false, cancelled: false, staleScope: false };
    const next = await fetchPage(cursor);
    const merged = mergeDirectoryPage(directory, next);
    if (!merged) return { directory, matched: false, cancelled: false, staleScope: true };
    directory = merged;
    if (options.matches && next.entries.some(entry => options.matches!(entry))) {
      return { directory, matched: true, cancelled: false, staleScope: false };
    }
  }
  return { directory, matched: false, cancelled: false, staleScope: false };
}
