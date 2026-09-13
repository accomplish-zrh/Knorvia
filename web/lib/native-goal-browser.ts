import type { NativeGoal } from "@/lib/knorvia-native-types";

/**
 * Cross-project goal browsing (B14).
 *
 * The previous view looped `goal/list` per workspace and published whatever
 * the last walk collected with no generation check, so a slow project A
 * response could land after the user switched to project B and overwrite the
 * visible list, and the 5s poll could overlap itself. The browser is
 * single-flight (at most one walk at a time; a demand arriving mid-walk marks
 * a rerun instead of queueing), generation-guarded (a superseded walk's
 * partial results are dropped), and per-project failures are reported as
 * incomplete coverage while healthy projects keep rendering.
 */

export type GoalScope = "all" | "single";
export type GoalStatusFilter = "ongoing" | "finished";

export type GoalQuery = {
  scope: GoalScope;
  workspaceId: string;
  search: string;
  status: GoalStatusFilter;
};

export type GoalBrowserState = {
  goals: NativeGoal[];
  /** Workspaces whose goal/list failed in the last completed walk. */
  failures: string[];
  loading: boolean;
};

export const GOALS_RENDER_LIMIT = 100;

const FINISHED_STATUSES = ["completed", "cancelled"];

const matchesText = (goal: NativeGoal, terms: string[]): boolean => {
  if (!terms.length) return true;
  const haystack = `${goal.title}\n${goal.successCriteria ?? ""}\n${goal.constraints ?? ""}`.toLowerCase();
  return terms.every(term => haystack.includes(term));
};

/** Client-side projection: scope, status, and goal/criteria text search. */
export function filterGoals(goals: NativeGoal[], query: GoalQuery): NativeGoal[] {
  const terms = query.search.toLowerCase().split(/\s+/).filter(Boolean);
  return goals.filter(goal =>
    (query.scope === "all" || goal.workspaceId === query.workspaceId)
    && (query.status === "finished" ? FINISHED_STATUSES.includes(goal.status) : !FINISHED_STATUSES.includes(goal.status))
    && matchesText(goal, terms));
}

type GoalLister = (workspaceId: string) => Promise<{ goals: NativeGoal[] }>;

export class GoalBrowser {
  private generation = 0;
  private running = false;
  private rerun = false;
  private targets: string[] = [];
  private flight: Promise<void> | null = null;
  private state: GoalBrowserState = { goals: [], failures: [], loading: true };
  private readonly listeners = new Set<() => void>();

  constructor(private readonly lister: GoalLister) {}

  getSnapshot = (): GoalBrowserState => this.state;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private publish(patch: Partial<GoalBrowserState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  /**
   * Repeated polls share the current walk. A changed scope or an explicit
   * mutation refresh schedules one replacement; stale results are discarded.
   */
  load(targets: string[], force = false): Promise<void> {
    const next = [...new Set(targets)].sort();
    const changed = JSON.stringify(next) !== JSON.stringify(this.targets);
    this.targets = next;
    if (this.running) {
      // A slow response must still become visible despite repeated timer ticks.
      // Only a new scope or an explicit post-mutation refresh supersedes it.
      if (changed || force) { this.rerun = true; this.generation += 1; }
      return this.flight ?? Promise.resolve();
    }
    this.running = true;
    this.flight = this.run();
    return this.flight;
  }

  cancel() {
    this.generation += 1;
    this.rerun = false;
    this.targets = [];
    this.publish({ goals: [], failures: [], loading: false });
  }

  private async run(): Promise<void> {
    try {
      do {
        this.rerun = false;
        const generation = ++this.generation;
        const targets = this.targets;
        this.publish({ loading: true, goals: this.state.goals.filter(goal => targets.includes(goal.workspaceId)), failures: [] });
        const collected: NativeGoal[] = [];
        const failures: string[] = [];
        let stale = false;
        for (const id of targets) {
          try {
            const result = await this.lister(id);
            if (generation !== this.generation) { stale = true; break; }
            if (!Array.isArray(result?.goals) || result.goals.some(goal => goal.workspaceId !== id || !goal.id || !Number.isInteger(goal.revision))) throw new Error("Invalid project goal list");
            collected.push(...result.goals);
          } catch {
            // A failing project must not hide the healthy ones; the view
            // marks coverage as incomplete.
            failures.push(id);
          }
          if (generation !== this.generation) { stale = true; break; }
        }
        // A newer demand arrived mid-walk: drop these partial results and
        // rerun against the freshest targets instead of publishing them.
        if (stale) continue;
        if (generation !== this.generation) continue;
        this.publish({ goals: collected, failures, loading: false });
      } while (this.rerun);
    } finally {
      this.running = false;
      this.flight = null;
    }
  }
}
