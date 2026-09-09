/** Goal status vocabulary and the actions each status allows.
 *
 * Shared by the Goals view so the UI cannot offer an action the kernel's
 * durable transition rules will refuse (terminal states stay terminal, and a
 * blocked goal resumes before it can be marked done).
 */

export const GOAL_STATUSES = ["active", "paused", "blocked", "completed", "cancelled"] as const

export type GoalStatus = (typeof GOAL_STATUSES)[number]

export type GoalAction = "pause" | "resume" | "complete"

const STATUS_LABELS: Record<GoalStatus, { zh: string; en: string }> = {
  active: { zh: "推进中", en: "Active" },
  paused: { zh: "已暂停", en: "Paused" },
  blocked: { zh: "受阻", en: "Blocked" },
  completed: { zh: "已完成", en: "Completed" },
  cancelled: { zh: "已取消", en: "Cancelled" },
}

export function goalStatusLabel(status: string): { zh: string; en: string } {
  return STATUS_LABELS[status as GoalStatus] ?? { zh: status, en: status }
}

export function goalActions(status: string): GoalAction[] {
  switch (status) {
    case "active":
      return ["pause", "complete"]
    case "paused":
    case "blocked":
      return ["resume", "complete"]
    default:
      return []
  }
}

export function isActiveGoal(status: string): boolean {
  return status === "active"
}

/** Separate the known goal/run envelope for display, without changing history.
 * Ambiguous or unfamiliar formats stay intact. The context remains expandable.
 */
export function goalConversationInput(text: string, goalId?: string | null): { input: string; context: string } | null {
  if (!goalId || !text.startsWith("Goal: ")) return null
  const normalized = text.replaceAll("\r\n", "\n")
  for (const marker of ["\nAcceptance criteria: ", "\nStanding constraints: ", "\n\nNext action: "]) {
    if (normalized.split(marker).length !== 2) return null
  }
  const match = /^Goal: [^\n]+\nAcceptance criteria: [\s\S]*?\nStanding constraints: [\s\S]*?\n\nNext action: ([\s\S]+)$/.exec(normalized)
  if (!match) return null
  return { input: match[1], context: normalized.slice(0, normalized.indexOf("\n\nNext action: ")) }
}
