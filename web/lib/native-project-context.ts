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
