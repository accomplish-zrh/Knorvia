import test from "node:test";
import assert from "node:assert/strict";
import { buildVariant, previewVariant, variantSourceKey, CANVAS_NODE_LIMIT, VARIANT_OFFSET } from "../lib/native-canvas-variants";
import type { CanvasDocument, CanvasEdge, CanvasNode } from "../lib/native-canvas";

let sequence = 0;
const node = (overrides: Partial<CanvasNode> = {}): CanvasNode => {
  sequence += 1;
  return { id: `n${sequence}`, kind: "text", title: `Node ${sequence}`, x: sequence * 10, y: sequence * 5, prompt: "p", ...overrides };
};
const edge = (from: string, to: string, role: CanvasEdge["role"]): CanvasEdge => ({ id: `e-${from}-${to}-${role}`, from, to, role });

const doc = (nodes: CanvasNode[], edges: CanvasEdge[]): CanvasDocument => ({
  schemaVersion: 1, id: "c1", title: "board", revision: 3, globalPrompt: "", nodes, edges, createdAt: "", updatedAt: "",
});

let counter = 0;
const freshId = () => `copy-${++counter}`;

test("variants strip unknown execution fields, detach settings and reject colliding ids", () => {
  const source = node({ id: 'source', settings: { size: '100x100' } });
  Object.assign(source, { resultId: 'old-result', attempt: 'old-attempt', outputs: ['old-output'] });
  const board = doc([source], []), before = variantSourceKey(board);
  const copied = buildVariant(board, ['source']);
  assert.ok(copied.ok);
  if (!copied.ok) return;
  assert.equal('resultId' in copied.nodes[0], false);
  assert.equal('attempt' in copied.nodes[0], false);
  assert.equal('outputs' in copied.nodes[0], false);
  copied.nodes[0].settings!.size = 'different';
  assert.equal(source.settings!.size, '100x100');
  assert.equal(variantSourceKey(board), before);
  assert.deepEqual(buildVariant(board, ['source'], { idFactory: () => 'source' }), { ok: false, reason: 'identity' });
  board.revision += 1;
  assert.notEqual(variantSourceKey(board), before);
});

test("preview does not miscount completely unrelated outside edges as dropped", () => {
  const board = doc([node({id:'a'}),node({id:'b'}),node({id:'c'})],[edge('b','c','context')]);
  assert.equal(previewVariant(board,['a']).droppedEdges.length,0);
});

test("copying text+asset+image keeps internal links, drops outside links, and mints every id", () => {
  const text = node({ id: "t1", kind: "text" });
  const asset = node({ id: "a1", kind: "asset", reference: { id: "lib-1", version: "sha-a", name: "cat.png" } });
  const image = node({ id: "i1", kind: "image", jobId: "job-9", settings: { aspect: "1:1" } });
  const outside = node({ id: "v1", kind: "video" });
  const board = doc([text, asset, image, outside], [
    edge("t1", "i1", "context"),
    edge("a1", "i1", "reference"),
    edge("i1", "v1", "firstFrame"),   // touches the outside selection
    edge("t1", "v1", "context"),      // touches the outside selection
  ]);
  const preview = previewVariant(board, ["t1", "a1", "i1"]);
  assert.deepEqual(preview.internalEdges.map(item => `${item.from}->${item.to}:${item.role}`).sort(), ["a1->i1:reference", "t1->i1:context"]);
  assert.equal(preview.droppedEdges.length, 2);

  const result = buildVariant(board, ["t1", "a1", "i1"], { idFactory: freshId });
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.nodes.length, 3);
  assert.equal(result.edges.length, 2);
  const ids = result.nodes.map(item => item.id);
  assert.equal(new Set(ids).size, 3);
  for (const id of ids) assert.match(id, /^copy-/);
  // Execution identity never travels with the copy.
  assert.ok(result.nodes.every(item => item.jobId === undefined && item.job === undefined));
  // Fixed asset version and parameters are preserved verbatim.
  const copiedAsset = result.nodes.find(item => item.title !== undefined && item.reference);
  assert.deepEqual(copiedAsset?.reference, { id: "lib-1", version: "sha-a", name: "cat.png" });
  const copiedImage = result.nodes.find(item => item.settings?.aspect === "1:1");
  assert.ok(copiedImage);
  // Predictable offset applied; the original document is untouched.
  assert.equal(result.nodes[0].x, text.x + VARIANT_OFFSET.x);
  assert.equal(result.nodes[0].y, text.y + VARIANT_OFFSET.y);
  assert.equal(board.nodes.find(item => item.id === "i1")?.jobId, "job-9");
  // Original graph unchanged: still 4 nodes / 4 edges.
  assert.equal(board.nodes.length, 4);
  assert.equal(board.edges.length, 4);
});

test("a running or finished node near the cap fails the whole copy without side effects", () => {
  const nodes = Array.from({ length: CANVAS_NODE_LIMIT - 1 }, (_, index) => node({ id: `fill${index}` }));
  nodes.push(node({ id: "busy", jobId: "job-live", kind: "image" }));
  const board = doc(nodes, []);
  const result = buildVariant(board, ["busy"], { idFactory: freshId });
  assert.deepEqual(result, { ok: false, reason: "limit" });
  assert.equal(board.nodes.length, CANVAS_NODE_LIMIT);
});

test("an empty selection and invalid internal links are handled honestly", () => {
  const text = node({ id: "t1", kind: "text" });
  const image = node({ id: "i1", kind: "image" });
  const board = doc([text, image], [edge("i1", "t1", "reference")]); // reference must target image; illegal inside copy
  const preview = previewVariant(board, ["t1", "i1"]);
  assert.equal(preview.internalEdges.length, 0);
  assert.equal(preview.droppedEdges.length, 1);
  assert.deepEqual(buildVariant(board, [], { idFactory: freshId }), { ok: false, reason: "empty" });
  // Two different prompts may both feed one image, but an exact duplicate
  // triple and an illegal role are not inherited into the copy.
  const withDup = doc([text, node({ id: "t2", kind: "text" }), image], [edge("t1", "i1", "context"), edge("t1", "i1", "context"), edge("t2", "i1", "context"), edge("t2", "i1", "reference")]);
  const preview2 = previewVariant(withDup, ["t1", "t2", "i1"]);
  assert.equal(preview2.internalEdges.length, 2);
  assert.equal(preview2.droppedEdges.length, 2);
});
