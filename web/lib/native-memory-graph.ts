import type { PresetLayoutOptions } from "cytoscape";

/** Canvas renderers do not reliably wrap CJK text at word boundaries. */
export function memoryGraphPreview(content: string): string {
  const lines: string[] = []; let line = ""; let units = 0;
  for (const character of Array.from(content.replace(/\s+/gu, " ").trim())) {
    const width = (character.codePointAt(0) ?? 0) > 255 ? 2 : 1;
    if (units + width > 30 && line) { lines.push(line); line = ""; units = 0; }
    line += character; units += width;
  }
  if (line) lines.push(line);
  if (lines.length <= 3) return lines.join("\n");
  const tail = Array.from(lines[2]);
  while (tail.reduce((sum, character) => sum + ((character.codePointAt(0) ?? 0) > 255 ? 2 : 1), 0) > 28) tail.pop();
  return [...lines.slice(0, 2), `${tail.join("")}…`].join("\n");
}

/** Stable, finite layout. No animation loop or force simulation, including
 * on devices requesting reduced motion. Nodes remain clickable at 1k. */
export function memoryGraphLayout(ids: string[], edges: Array<{ fromId: string; toId: string }> = []): PresetLayoutOptions {
  const sorted = [...new Set(ids)].sort();
  const adjacent = new Map(sorted.map(id => [id, new Set<string>()]));
  for (const edge of edges) {
    if (edge.fromId === edge.toId || !adjacent.has(edge.fromId) || !adjacent.has(edge.toId)) continue;
    adjacent.get(edge.fromId)!.add(edge.toId); adjacent.get(edge.toId)!.add(edge.fromId);
  }
  const rank = (a: string, b: string) => adjacent.get(b)!.size - adjacent.get(a)!.size || a.localeCompare(b);
  const visited = new Set<string>(); const groups: string[][] = [];
  for (const seed of [...sorted].sort(rank)) {
    if (visited.has(seed)) continue;
    const group = [seed]; visited.add(seed);
    for (let index = 0; index < group.length; index++) {
      for (const id of [...adjacent.get(group[index])!].sort(rank)) {
        if (!visited.has(id)) { visited.add(id); group.push(id); }
      }
    }
    groups.push(group);
  }
  groups.sort((a, b) => b.length - a.length || a[0].localeCompare(b[0]));
  const canvasWidth = Math.max(930, Math.ceil(Math.sqrt(sorted.length)) * 310);
  const positions: Record<string, { x: number; y: number }> = {};
  let left = 0, top = 0, rowHeight = 0;
  for (const group of groups) {
    const columns = Math.min(Math.ceil(Math.sqrt(group.length)), Math.floor(canvasWidth / 310));
    const width = columns * 310; const height = Math.ceil(group.length / columns) * 190;
    if (left > 0 && left + width > canvasWidth) { left = 0; top += rowHeight + 55; rowHeight = 0; }
    group.forEach((id, index) => { positions[id] = { x: left + (index % columns) * 310, y: top + Math.floor(index / columns) * 190 }; });
    left += width + 55; rowHeight = Math.max(rowHeight, height);
  }
  return { name: "preset", positions, animate: false, fit: true, padding: 30 };
}
