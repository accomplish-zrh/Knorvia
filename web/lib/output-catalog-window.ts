/** Clamp a window start so a full window is visible whenever rows allow. */
export function clampWindowStart(start: number, rowCount: number, window: number): number {
  const maxStart = Math.max(0, rowCount - window);
  return Math.min(Math.max(0, start), maxStart);
}
