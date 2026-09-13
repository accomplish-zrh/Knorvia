import type { CanvasDocument, CanvasEdge, CanvasNode } from "./native-canvas";
import { canvasConnectionIssue } from "./native-canvas-graph";

/**
 * Safe subgraph copy for canvas variants (B19).
 *
 * A copy rebuilds ONLY the connections whose both ends are selected and that
 * are still legal inside the copy; external links are reported as dropped,
 * never inherited. Every node/edge gets a fresh id, position shifts by a
 * predictable offset, and execution identities (jobId/job — active or
 * finished) are stripped, so a variant can never auto-start or impersonate a
 * paid generation. The caller applies the result as one edit step, so a
 * single undo/redo restores the whole operation.
 */

export const CANVAS_NODE_LIMIT = 80;
export const VARIANT_OFFSET = { x: 480, y: 360 };

export type VariantPreview = {
  nodes: CanvasNode[];
  /** Edges with both ends selected that remain legal within the copy. */
  internalEdges: CanvasEdge[];
  /** Edges that will NOT be copied (touching the outside, or illegal/duplicate inside). */
  droppedEdges: CanvasEdge[];
};

export type VariantBuild =
  | { ok: true; nodes: CanvasNode[]; edges: CanvasEdge[]; dropped: number }
  | { ok: false; reason: "empty" | "limit" | "identity" };

export function previewVariant(document: CanvasDocument, selectedIds: readonly string[]): VariantPreview {
  const byId = new Map(document.nodes.map(node => [node.id, node]));
  const nodes: CanvasNode[] = [];
  const seen = new Set<string>();
  for (const id of selectedIds) {
    if (seen.has(id)) continue;
    const node = byId.get(id);
    if (!node) continue;
    seen.add(id);
    nodes.push(node);
  }
  const memberSet = seen;
  const internalEdges: CanvasEdge[] = [];
  const droppedEdges: CanvasEdge[] = [];
  for (const edge of document.edges) {
    if (!memberSet.has(edge.from) && !memberSet.has(edge.to)) continue;
    if (!memberSet.has(edge.from) || !memberSet.has(edge.to)) { droppedEdges.push(edge); continue; }
    // Validity is judged inside the copy, so duplicates or role conflicts of
    // the original graph are not silently inherited.
    if (canvasConnectionIssue(nodes, internalEdges, { from: edge.from, to: edge.to, role: edge.role })) {
      droppedEdges.push(edge);
      continue;
    }
    internalEdges.push(edge);
  }
  return { nodes, internalEdges, droppedEdges };
}

export type VariantIdFactory = () => string;

export function buildVariant(
  document: CanvasDocument,
  selectedIds: readonly string[],
  options: { idFactory?: VariantIdFactory; offset?: { x: number; y: number } } = {},
): VariantBuild {
  const preview = previewVariant(document, selectedIds);
  if (!preview.nodes.length) return { ok: false, reason: "empty" };
  if (document.nodes.length + preview.nodes.length > CANVAS_NODE_LIMIT) return { ok: false, reason: "limit" };
  const newId = options.idFactory ?? (() => (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `node-${Date.now()}-${Math.random().toString(16).slice(2)}`));
  const offset = options.offset ?? VARIANT_OFFSET;
  const reserved = new Set([...document.nodes, ...document.edges].map(item => item.id));
  const fresh = (): string | null => {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const id = newId();
      if (id && !reserved.has(id)) { reserved.add(id); return id; }
    }
    return null;
  };
  const idMap = new Map<string, string>();
  for (const node of preview.nodes) {
    const id = fresh();
    if (!id) return { ok: false, reason: "identity" };
    idMap.set(node.id, id);
  }
  // Execution identity (jobId/job — running or finished) is never copied; the
  // variant is an unexecuted plan. Fixed asset references (id + version) and
  // all parameters are preserved verbatim.
  const nodes = preview.nodes.map(node => {
    // Copy editable fields only, excluding current or future run identities.
    const { kind, title, prompt, profileId, reference, settings } = node;
    return { id: idMap.get(node.id)!, kind, title, prompt, profileId,
      reference: reference ? { ...reference } : undefined, settings: settings ? { ...settings } : undefined,
      x: node.x + offset.x, y: node.y + offset.y };
  });
  const edges: CanvasEdge[] = [];
  for (const edge of preview.internalEdges) {
    const id = fresh();
    if (!id) return { ok: false, reason: "identity" };
    edges.push({ id, from: idMap.get(edge.from)!, to: idMap.get(edge.to)!, role: edge.role });
  }
  return { ok: true, nodes, edges, dropped: preview.droppedEdges.length };
}

/** A review refers to the exact board and source state that the user saw. */
export function variantSourceKey(document: CanvasDocument): string {
  return JSON.stringify(document);
}
