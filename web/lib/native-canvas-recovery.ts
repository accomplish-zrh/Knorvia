import type { CanvasDocument, CanvasEdge } from './native-canvas';
import { canvasConnectionIssue } from './native-canvas-graph';

/** Recovery data is local input, never trusted as an executable or renderable graph. */
export function validCanvasDraft(value: unknown): value is CanvasDocument {
  if (!value || typeof value !== 'object') return false;
  const doc = value as CanvasDocument;
  const text = (v: unknown, max: number) => typeof v === 'string' && v.length <= max && !v.includes('\0');
  const id = (v: unknown) => text(v, 80) && /^[a-zA-Z0-9_-]+$/.test(v as string);
  if (doc.schemaVersion !== 1 || !id(doc.id) || !Number.isInteger(doc.revision) || doc.revision < 1 || !text(doc.title, 120) || !text(doc.globalPrompt, 8000)) return false;
  if (!Array.isArray(doc.nodes) || doc.nodes.length > 80 || !Array.isArray(doc.edges) || doc.edges.length > 200) return false;
  const ids = new Set<string>();
  for (const n of doc.nodes) {
    if (!n || !id(n.id) || ids.has(n.id) || !['text', 'asset', 'image', 'video'].includes(n.kind) || !text(n.title, 120) || !Number.isFinite(n.x) || !Number.isFinite(n.y)) return false;
    if (n.prompt !== undefined && !text(n.prompt, 8000) || n.profileId !== undefined && !text(n.profileId, 100)) return false;
    if (n.reference && (!id(n.reference.id) || typeof n.reference.version !== 'string' || !/^[a-f0-9]{64}$/i.test(n.reference.version))) return false;
    if (n.settings && (typeof n.settings !== 'object' || Array.isArray(n.settings) || Object.entries(n.settings).some(([key, val]) => ['size', 'aspect', 'quality'].includes(key) ? !text(val, 40) : !['count', 'seconds'].includes(key) || !Number.isFinite(val)))) return false;
    ids.add(n.id);
  }
  const accepted: CanvasEdge[] = [], edgeIds = new Set<string>();
  for (const edge of doc.edges) {
    if (!edge || !id(edge.id) || edgeIds.has(edge.id) || canvasConnectionIssue(doc.nodes, accepted, edge)) return false;
    accepted.push(edge); edgeIds.add(edge.id);
  }
  return true;
}

const handoffKey = 'knorvia-canvas-handoff';
export type CanvasHandoff = { id: string; text: string };
export function readCanvasHandoff(): CanvasHandoff | undefined {
  try {
    const value = JSON.parse(sessionStorage.getItem(handoffKey) || 'null');
    if (value && /^[a-f0-9-]{36}$/i.test(value.id) && typeof value.text === 'string' && value.text.length <= 4000) return { id: value.id, text: value.text };
  } catch { /* optional per-window composer reference */ }
}
export function keepCanvasHandoff(value?: CanvasHandoff) {
  if (value) sessionStorage.setItem(handoffKey, JSON.stringify(value));
  else try { sessionStorage.removeItem(handoffKey); } catch { /* current state stays usable */ }
}
