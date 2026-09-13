import { panelKey, previewUrl, type PanelState, type PanelTab, type PanelTarget } from './native-panel';

export type ReadingPosition = { top: number; anchor?: string; offset?: number; bottom: boolean };
export type TaskViewMemory = { panel: { open: boolean; content: PanelState }; contextFiles: string[]; canvasContext?: string; reading?: ReadingPosition };
export const emptyTaskView = (): TaskViewMemory => ({ panel: { open: false, content: { tabs: [], active: null } }, contextFiles: [] });
const prefix = 'knorvia-task-view-v1:';
const text = (value: unknown, max = 4096): value is string => typeof value === 'string' && value.length <= max && !value.includes('\0');
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value);
const recordId = (value: unknown): value is string => text(value, 200) && /^[a-zA-Z0-9_-]+$/.test(value);
const position = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(100_000_000, value)) : 0;

/** Only restore navigation metadata. Restoration never issues an execution request. */
export function parseTaskView(raw: string): TaskViewMemory {
  try {
    const value = JSON.parse(raw);
    if (value?.version !== 1) return emptyTaskView();
    const tabs: PanelTab[] = [], keys = new Set<string>();
    for (const entry of Array.isArray(value.panel?.content?.tabs) ? value.panel.content.tabs.slice(0, 40) : []) {
      const rawTarget = entry?.target;
      if (!rawTarget) continue;
      let target: PanelTarget | undefined;
      if (rawTarget.kind === 'files') target = { kind: 'files', ...(text(rawTarget.folder) ? { folder: rawTarget.folder } : {}) };
      else if (rawTarget.kind === 'canvas' && (!rawTarget.id || uuid(rawTarget.id))) target = { kind: 'canvas', ...(rawTarget.id ? { id: rawTarget.id } : {}) };
      else if (rawTarget.kind === 'file' && text(rawTarget.path) && rawTarget.path) target = { kind: 'file', path: rawTarget.path };
      else if (rawTarget.kind === 'changes' || rawTarget.kind === 'activity') target = { kind: rawTarget.kind };
      else if (rawTarget.kind === 'browser' && (!rawTarget.url || (text(rawTarget.url) && previewUrl(rawTarget.url)))) target = { kind: 'browser', ...(rawTarget.url ? { url: previewUrl(rawTarget.url)! } : {}) };
      else if (rawTarget.kind === 'chat' && uuid(rawTarget.id)) target = { kind: 'chat', id: rawTarget.id, ...(recordId(rawTarget.threadId) ? { threadId: rawTarget.threadId } : {}) };
      else if (rawTarget.kind === 'terminal' && uuid(rawTarget.id)) target = { kind: 'terminal', id: rawTarget.id, restore: true };
      else if (rawTarget.kind === 'artifact' && recordId(rawTarget.artifact?.id) && text(rawTarget.artifact?.title, 500) && text(rawTarget.artifact?.type, 100)) {
        const artifact = rawTarget.artifact;
        target = { kind: 'artifact', artifact: { id: artifact.id, title: artifact.title, type: artifact.type, workspaceId: recordId(artifact.workspaceId) ? artifact.workspaceId : '', lifecycle: text(artifact.lifecycle, 100) ? artifact.lifecycle : '', revision: position(artifact.revision), updatedAt: text(artifact.updatedAt, 100) ? artifact.updatedAt : '' } };
      }
      if (!target) continue;
      const id = panelKey(target);
      if (keys.has(id)) continue;
      keys.add(id);
      const view = entry.view;
      const history: string[] = Array.isArray(view?.history) ? view.history.slice(-40).filter((url: unknown): url is string => text(url) && Boolean(previewUrl(url))).map((url: string) => previewUrl(url)!) : [];
      tabs.push({ id, target, ...(view ? { view: { top: position(view.top), left: position(view.left), source: view.source === true, ...(history.length ? { history, index: Math.max(0, Math.min(history.length - 1, Math.floor(position(view.index)))) } : {}) } } : {}) });
    }
    const active = value.panel?.content?.active;
    const reading = value.reading;
    return {
      panel: { open: value.panel?.open === true, content: { tabs, active: keys.has(active) ? active : null } },
      contextFiles: Array.isArray(value.contextFiles) ? [...new Set<string>(value.contextFiles.filter((path: unknown): path is string => text(path) && Boolean(path)))].slice(0, 20) : [],
      ...(text(value.canvasContext, 4000) ? { canvasContext: value.canvasContext } : {}),
      ...(reading ? { reading: { top: position(reading.top), bottom: reading.bottom === true, ...(text(reading.anchor, 200) ? { anchor: reading.anchor } : {}), offset: typeof reading.offset === 'number' && Number.isFinite(reading.offset) ? reading.offset : 0 } } : {}),
    };
  } catch { return emptyTaskView(); }
}

const fallback = new Map<string, string>();
export function readTaskView(id: string): TaskViewMemory {
  try { return parseTaskView(fallback.get(id) ?? sessionStorage.getItem(prefix + id) ?? ''); }
  catch { return parseTaskView(fallback.get(id) ?? ''); }
}
export function saveTaskView(id: string, update: Partial<TaskViewMemory>) {
  // One browser window owns its view; another window keeps its own reading position.
  const raw = JSON.stringify({ version: 1, ...readTaskView(id), ...update });
  fallback.delete(id); fallback.set(id, raw);
  while (fallback.size > 40) fallback.delete(fallback.keys().next().value!);
  try {
    sessionStorage.setItem(prefix + id, raw);
    const keys = Array.from({ length: sessionStorage.length }, (_, index) => sessionStorage.key(index)!).filter(key => key.startsWith(prefix) && key !== prefix + id);
    for (const key of keys.slice(0, Math.max(0, keys.length - 39))) sessionStorage.removeItem(key);
  } catch { /* Keep this window usable if browser storage is unavailable. */ }
}
