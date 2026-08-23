export type WireRect = { x: number; y: number; width: number; height: number }
export type WirePoint = { x: number; y: number }

export type WireHandles = {
  start: WirePoint
  end: WirePoint
  c1: WirePoint
  c2: WirePoint
  mid: WirePoint
  bend: number
}

function cubicPoint(p0: WirePoint, p1: WirePoint, p2: WirePoint, p3: WirePoint, t: number): WirePoint {
  const u = 1 - t
  return {
    x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
    y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
  }
}

function distanceToSegment(point: WirePoint, a: WirePoint, b: WirePoint): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const length = dx * dx + dy * dy
  if (length <= 0) return Math.hypot(point.x - a.x, point.y - a.y)
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / length))
  return Math.hypot(point.x - (a.x + dx * t), point.y - (a.y + dy * t))
}

function fmt(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : '0'
}

/** Right-to-left node cables with distance-aware pull so vertical and reverse links stay rounded. */
export function wireHandles(from: WireRect, to: WireRect): WireHandles {
  const start = { x: from.x + from.width, y: from.y + from.height / 2 }
  const end = { x: to.x, y: to.y + to.height / 2 }
  const dx = end.x - start.x
  const dy = end.y - start.y
  const dist = Math.hypot(dx, dy)
  const backward = dx < 36
  const pull = Math.min(
    260,
    Math.max(36, dist * (backward ? 0.5 : 0.36), Math.abs(dy) * (backward ? 0.45 : 0.3), backward ? 80 : 36)
  )
  const c1 = { x: start.x + pull, y: start.y }
  const c2 = { x: end.x - pull, y: end.y }
  return {
    start,
    end,
    c1,
    c2,
    mid: cubicPoint(start, c1, c2, end, 0.5),
    bend: pull,
  }
}

export function wirePath(from: WireRect, to: WireRect): string {
  const { start, end, c1, c2 } = wireHandles(from, to)
  return `M ${fmt(start.x)} ${fmt(start.y)} C ${fmt(c1.x)} ${fmt(c1.y)}, ${fmt(c2.x)} ${fmt(c2.y)}, ${fmt(end.x)} ${fmt(end.y)}`
}

export function hitTestWire(from: WireRect, to: WireRect, point: WirePoint, threshold: number): boolean {
  const { start, end, c1, c2 } = wireHandles(from, to)
  const samples = 20
  let previous = start
  for (let step = 1; step <= samples; step += 1) {
    const current = cubicPoint(start, c1, c2, end, step / samples)
    if (distanceToSegment(point, previous, current) <= threshold) return true
    previous = current
  }
  return false
}
