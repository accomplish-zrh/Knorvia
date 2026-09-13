import type { Artifact } from './native-workbench-state';

export type PanelTarget =
  | { kind: 'canvas'; id?: string }
  | { kind: 'files'; folder?: string }
  | { kind: 'file'; path: string; line?: number; column?: number }
  | { kind: 'changes' | 'activity' }
  | { kind: 'browser'; url?: string }
  | { kind: 'chat'; id: string; threadId?: string }
  | { kind: 'terminal'; id: string; restore?: boolean }
  | { kind: 'ssh'; id?: string }
  | { kind: 'artifact'; artifact: Artifact };
export type PanelTabView = { top?: number; left?: number; source?: boolean; history?: string[]; index?: number };
export type PanelTab = { id: string; target: PanelTarget; view?: PanelTabView };
export type PanelState = { tabs: PanelTab[]; active: string | null };

export function panelKey(target: PanelTarget): string {
  if (target.kind === 'canvas') return `canvas:${target.id || 'home'}`;
  if (target.kind === 'file') return `file:${target.path.replaceAll('\\', '/')}`;
  if (target.kind === 'browser') return `browser:${target.url || 'new'}`;
  if (target.kind === 'artifact') return `artifact:${target.artifact.id}`;
  if (target.kind === 'chat') return `chat:${target.id}`;
  if (target.kind === 'terminal') return `terminal:${target.id}`;
  if (target.kind === 'ssh') return `ssh:${target.id || 'hosts'}`;
  return target.kind;
}
export function openPanelTab(state: PanelState, target: PanelTarget): PanelState {
  const id = panelKey(target);
  const existing = state.tabs.find(tab => tab.id === id);
  return { tabs: existing ? state.tabs.map(tab => tab.id === id ? { ...tab, target: { ...tab.target, ...target } as PanelTarget } : tab) : [...state.tabs, { id, target }], active: id };
}
export function closePanelTab(state: PanelState, id: string): PanelState {
  const index = state.tabs.findIndex(tab => tab.id === id);
  if (index < 0) return state;
  const tabs = state.tabs.filter(tab => tab.id !== id);
  return { tabs, active: state.active === id ? tabs[Math.min(index, tabs.length - 1)]?.id ?? null : state.active };
}
export function previewUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
export type WorkspaceLinkTarget = { path: string; line?: number; column?: number };

function normalizeWorkspacePath(path: string, cwd: string, folder: string): string | null {
  let rest = path;
  const root = cwd.replaceAll('\\', '/').replace(/\/$/, '');
  if (/^file:\/\//i.test(rest)) rest = rest.replace(/^file:\/\/\/?/i, '');
  const absolute = /^(?:[a-z]:\/|\/)/i.test(rest);
  if (absolute) {
    if (!root || !rest.toLowerCase().startsWith(`${root.toLowerCase()}/`)) return null;
    rest = rest.slice(root.length + 1);
  }
  if (!rest || /[:?#\0]/.test(rest) || rest.startsWith('//')) return null;
  const parts = absolute ? [] : folder.split('/').filter(Boolean);
  for (const part of rest.split('/')) {
    if (part === '..') { if (!parts.length) return null; parts.pop(); }
    else if (part && part !== '.') parts.push(part);
  }
  return parts.join('/') || null;
}

/**
 * B16: classify a task reference into a project-relative file target plus an
 * optional 1-based line/column position. Malformed encodings, out-of-project
 * absolute paths, escapes above the root, and illegal line numbers are all
 * rejected; `file://` URLs are bounded by the project root like plain paths.
 */
export function workspaceLinkTarget(value: string, cwd: string, folder = ''): WorkspaceLinkTarget | null {
  let path: string;
  try { path = decodeURIComponent(typeof value === 'string' ? value.trim() : ''); } catch { return null; }
  if (!path) return null;
  let line: number | undefined;
  let column: number | undefined;
  const suffix = /:([0-9]{1,5})(?::([0-9]{1,5}))?$/.exec(path);
  if (suffix) {
    const parsedLine = Number(suffix[1]);
    if (parsedLine >= 1) {
      line = parsedLine;
      if (suffix[2] !== undefined) {
        const parsedColumn = Number(suffix[2]);
        if (parsedColumn >= 1) column = parsedColumn;
      }
      path = path.slice(0, suffix.index);
    }
  }
  const normalized = normalizeWorkspacePath(path.replaceAll('\\', '/'), cwd, folder);
  if (!normalized) return null;
  return { path: normalized, line, column };
}

export function workspaceLink(value: string, cwd: string, folder = ''): string | null {
  return workspaceLinkTarget(value, cwd, folder)?.path ?? null;
}
