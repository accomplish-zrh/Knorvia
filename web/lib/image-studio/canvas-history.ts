/** A hard ceiling shared by mask editors. One 4K RGBA frame is ~64 MiB. */
export const CANVAS_HISTORY_BYTE_BUDGET = 64 * 1024 * 1024

type Snapshot = { data: { byteLength: number } }

export function canvasHistoryBytes(stacks: ReadonlyArray<ReadonlyArray<Snapshot>>): number {
  return stacks.reduce(
    (total, stack) =>
      total + stack.reduce((stackTotal, frame) => stackTotal + frame.data.byteLength, 0),
    0
  )
}

/**
 * Trim oldest snapshots until all undo/redo stacks fit inside the byte budget.
 * Mutates the supplied stacks to avoid copying multi-megabyte ImageData objects.
 */
export function trimCanvasHistory(
  stacks: Array<Snapshot[]>,
  budget = CANVAS_HISTORY_BYTE_BUDGET
): void {
  const safeBudget = Math.max(0, budget)
  while (canvasHistoryBytes(stacks) > safeBudget) {
    const candidate = stacks.find(stack => stack.length > 0)
    if (!candidate) return
    candidate.shift()
  }
}
