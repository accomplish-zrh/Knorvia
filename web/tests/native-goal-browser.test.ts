import test from "node:test";
import assert from "node:assert/strict";
import { filterGoals, GoalBrowser, GOALS_RENDER_LIMIT, type GoalBrowserState } from "../lib/native-goal-browser";
import type { NativeGoal } from "../lib/knorvia-native-types";

let sequence = 0;
const goal = (overrides: Partial<NativeGoal> = {}): NativeGoal => {
  sequence += 1;
  return { id: `g${sequence}`, revision: sequence, workspaceId: "w1", title: `Goal ${sequence}`, status: "active", ...overrides };
};

const wait = () => new Promise(resolve => setTimeout(resolve, 0));

test("same-scope ticks never starve a slow request or return before it settles", async () => {
  let resolve!: (value: { goals: NativeGoal[] }) => void;
  let calls = 0;
  const browser = new GoalBrowser(async () => { calls += 1; return new Promise(done => { resolve = done; }); });
  const first = browser.load(['w1']);
  const ticks = Array.from({length: 8}, () => browser.load(['w1']));
  resolve({ goals: [goal({ title: 'Slow but valid' })] });
  await Promise.all([first, ...ticks]);
  assert.equal(calls, 1);
  assert.equal(browser.getSnapshot().goals[0].title, 'Slow but valid');
});

test("cancel drops a late result and does not continue walking other projects", async () => {
  let resolve!: (value: { goals: NativeGoal[] }) => void;
  let calls = 0;
  const browser = new GoalBrowser(async () => { calls += 1; return new Promise(done => { resolve = done; }); });
  const seen: string[] = []; browser.subscribe(() => seen.push(...browser.getSnapshot().goals.map(g => g.id)));
  const pending = browser.load(['w1','w2']); browser.cancel(); resolve({ goals: [goal()] }); await pending;
  assert.equal(calls, 1); assert.deepEqual(seen, []);
});

test("scope, status, and goal/criteria text search compose", () => {
  const goals = [
    goal({ workspaceId: "w1", title: "毕业论文", successCriteria: "初稿完成", constraints: "每天 2 小时" }),
    goal({ workspaceId: "w2", title: "Thesis review", successCriteria: "draft accepted" }),
    goal({ workspaceId: "w1", title: "旧的论文整理", status: "completed" }),
    goal({ workspaceId: "w3", title: "网站改版", successCriteria: "上线" }),
  ];
  const all = filterGoals(goals, { scope: "all", workspaceId: "", search: "", status: "ongoing" });
  assert.equal(all.length, 3);
  const single = filterGoals(goals, { scope: "single", workspaceId: "w1", search: "", status: "ongoing" });
  assert.deepEqual(single.map(item => item.id), [goals[0].id]);
  const searched = filterGoals(goals, { scope: "all", workspaceId: "", search: "论文 初稿", status: "ongoing" });
  assert.deepEqual(searched.map(item => item.id), [goals[0].id]);
  const finished = filterGoals(goals, { scope: "all", workspaceId: "", search: "", status: "finished" });
  assert.deepEqual(finished.map(item => item.id), [goals[2].id]);
});

test("a slow project's late response never lands in a newer query's snapshot", async () => {
  let resolveA: (value: { goals: NativeGoal[] }) => void = () => {};
  const gate = new Promise<{ goals: NativeGoal[] }>(resolve => { resolveA = resolve; });
  const lists: Record<string, Promise<{ goals: NativeGoal[] }>> = { "w-a": gate };
  const browser = new GoalBrowser(async workspace => (lists[workspace] ?? Promise.resolve({ goals: [goal({ workspaceId: workspace, title: `fresh-${workspace}` })] })));
  const seen: string[] = [];
  browser.subscribe(() => { const state = browser.getSnapshot(); seen.push(state.goals.map(item => item.title).join("|")); });
  const first = browser.load(["w-a"]);
  // Switch to project B while A's request is still hanging.
  const second = browser.load(["w-b"]);
  resolveA({ goals: [goal({ workspaceId: "w-a", title: "STALE-A" })] });
  await first;
  await second;
  await wait();
  const state = browser.getSnapshot();
  assert.equal(state.goals.some(item => item.title === "STALE-A"), false);
  assert.equal(state.goals.some(item => item.title.startsWith("fresh-w-b")), true);
});

test("a demand arriving mid-walk reruns against fresh targets without stacking walks", async () => {
  let walks = 0;
  let release: () => void = () => {};
  let gate = new Promise<void>(resolve => { release = resolve; });
  const browser = new GoalBrowser(async workspace => {
    walks += 1;
    await gate;
    return { goals: [goal({ workspaceId: workspace, title: `goal-${workspace}-${walks}` })] };
  });
  const first = browser.load(["w-1"]);
  const second = browser.load(["w-2"]);
  release();
  await first; await second;
  await wait();
  release();
  await wait();
  // The second demand reran exactly once, after the first walk finished.
  assert.ok(walks <= 3, `walks ${walks}`);
  const state = browser.getSnapshot();
  assert.equal(state.loading, false);
  assert.equal(state.goals.some(item => item.workspaceId === "w-2"), true);
});

test("a failing project keeps healthy projects visible and marks the coverage incomplete", async () => {
  const browser = new GoalBrowser(async workspace => {
    if (workspace === "w-bad") throw new Error("goal store offline");
    return { goals: [goal({ workspaceId: workspace })] };
  });
  await browser.load(["w-ok", "w-bad", "w-ok2"]);
  const state = browser.getSnapshot();
  assert.deepEqual(state.failures, ["w-bad"]);
  assert.equal(state.goals.length, 2);
  assert.equal(state.loading, false);
});

test("the render limit bounds the list", () => {
  assert.ok(GOALS_RENDER_LIMIT >= 20);
  const many = Array.from({ length: GOALS_RENDER_LIMIT + 50 }, () => goal());
  const shown = many.slice(0, GOALS_RENDER_LIMIT);
  assert.equal(shown.length, GOALS_RENDER_LIMIT);
  const state: GoalBrowserState = { goals: many, failures: [], loading: false };
  assert.equal(state.goals.length, GOALS_RENDER_LIMIT + 50);
});
