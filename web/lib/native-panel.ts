import type { Artifact } from './native-workbench-state';

export type PanelTarget =
  | { kind: 'files'; folder?: string }
  | { kind: 'file'; path: string }
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
export function workspaceLink(value: string, cwd: string, folder = ''): string | null {
  let path: string;
  try { path = decodeURIComponent(value).replaceAll('\\', '/').replace(/:\d+(?::\d+)?$/, ''); } catch { return null; }
  const root = cwd.replaceAll('\\', '/').replace(/\/$/, '');
  if (/^file:\/\//i.test(path)) path = path.replace(/^file:\/\/\/?/i, '');
  const absolute = /^(?:[a-z]:\/|\/)/i.test(path);
  if (absolute) {
    if (!root || !path.toLowerCase().startsWith(`${root.toLowerCase()}/`)) return null;
    path = path.slice(root.length + 1);
  }
  if (!path || /[:?#\0]/.test(path) || path.startsWith('//')) return null;
  const parts = absolute ? [] : folder.split('/').filter(Boolean);
  for (const part of path.split('/')) {
    if (part === '..') { if (!parts.length) return null; parts.pop(); }
    else if (part && part !== '.') parts.push(part);
  }
  return parts.join('/') || null;
}
