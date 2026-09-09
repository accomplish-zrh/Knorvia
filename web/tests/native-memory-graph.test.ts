import assert from "node:assert/strict";
import test from "node:test";
import cytoscape from "cytoscape";
import { memoryGraphLayout, memoryGraphPreview } from "../lib/native-memory-graph";

test("the actual graph layout handles 1000 nodes deterministically without animation", () => {
  const nodes = Array.from({ length: 1000 }, (_, n) => ({ data: { id: `mem_${n.toString().padStart(4, "0")}` } }));
  const render = (elements: typeof nodes) => {
    const cy = cytoscape({ headless: true, elements, layout: memoryGraphLayout(elements.map(node => node.data.id)) });
    const positions = new Map(cy.nodes().map(node => [node.id(), node.position()]));
    assert.equal(positions.size, 1000);
    for (const position of positions.values()) assert.ok(Number.isFinite(position.x) && Number.isFinite(position.y));
    cy.destroy();
    return positions;
  };
  assert.deepEqual(render(nodes), render([...nodes].reverse()));
});

test("small connected memories form compact content-card groups", () => {
  const ids = ["a", "b", "c", "d", "e"];
  const edges = [{ fromId: "a", toId: "b" }, { fromId: "a", toId: "c" }, { fromId: "d", toId: "e" }];
  const layout = memoryGraphLayout(ids, edges);
  assert.deepEqual(layout, memoryGraphLayout([...ids].reverse(), [...edges].reverse()));
  const positions = layout.positions as Record<string, { x: number; y: number }>;
  assert.equal(Math.abs(positions.a.x - positions.b.x), 310);
  assert.ok(Math.abs(positions.a.y - positions.c.y) <= 190);
  assert.equal(positions.d.y, positions.e.y);
  assert.notDeepEqual(positions.a, positions.d);
});

test("graph previews wrap mixed CJK and Latin text without overflowing content cards", () => {
  const short = "研究记录：用海蓝色标记 TypeScript 与实验数据。";
  assert.equal(memoryGraphPreview(short).replace(/\n/g, ""), short);
  const wrapped = memoryGraphPreview("实验结论与回归验证需要按顺序记录。".repeat(12));
  assert.equal(wrapped.split("\n").length, 3);
  assert.ok(wrapped.endsWith("…"));
  for (const line of wrapped.split("\n")) assert.ok(Array.from(line).reduce((n, char) => n + (char.codePointAt(0)! > 255 ? 2 : 1), 0) <= 30);
});
