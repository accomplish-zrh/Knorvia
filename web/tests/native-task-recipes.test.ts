import test from "node:test";
import assert from "node:assert/strict";
import { applyRecipe, extractVariables, recipeVariables, recipeIssue, importRecipes, parseRecipes, removeRecipe, upsertRecipe, RECIPE_LIMIT, RECIPE_STORAGE_KEY, type TaskRecipe } from "../lib/native-task-recipes";

const recipe = (overrides: Partial<TaskRecipe> = {}): TaskRecipe => ({
  id: "r1", name: "评审方案", description: "code review", textTemplate: "请评审 {{module}}，关注 {{focus}}。", goal: { criteria: "{{module}} 的结论有文件依据", constraints: "只读" }, createdAt: 1, updatedAt: 1, ...overrides,
});

test("variables are extracted uniquely and filled per project without touching unset ones", () => {
  assert.deepEqual(extractVariables("review {{module}} then {{module}} and {{ focus_2 }}"), ["module", "focus_2"]);
  const filled = applyRecipe(recipe().textTemplate, recipe().goal, { module: "auth/", focus: "回归" });
  assert.equal(filled.text, "请评审 auth/，关注 回归。");
  assert.equal(filled.goal?.criteria, "auth/ 的结论有文件依据");
  // No execution: applying only returns text.
  const missing = applyRecipe(recipe().textTemplate, null, {});
  assert.match(missing.text, /\{\{module\}\}/);
});

test("applying the same plan in two projects only ever produces draft text", () => {
  const template = "评审 {{module}}";
  const one = applyRecipe(template, null, { module: "web/" });
  const two = applyRecipe(template, null, { module: "native/" });
  assert.notEqual(one.text, two.text);
  // Pure functions: no request identity, no provider/model/write fields exist.
  assert.equal("workspaceId" in one, false);
  assert.equal("model" in two, false);
});

test("import gives per-item results: conflicts replace, invalid entries are rejected", () => {
  const current = [recipe()];
  const outcome = importRecipes(current, [
    recipe({ id: "r1", name: "评审方案（更新）" }),
    recipe({ id: "r2", name: "新方案", textTemplate: "hi" }),
    { id: "bad id!", name: "坏数据" },
    { nope: true },
  ]);
  assert.equal(outcome.added.length, 1);
  assert.equal(outcome.replaced, 1);
  assert.equal(outcome.rejected.length, 2);
  assert.equal(outcome.recipes.find(item => item.id === "r1")?.name, "评审方案（更新）");
  assert.equal(importRecipes(current, "not a list").rejected[0].reason, "not a list");
});

test("stored recipes are validated, deduped, capped, and sorted by recency", () => {
  const many = Array.from({ length: RECIPE_LIMIT + 10 }, (_, index) => recipe({ id: `r${index}`, name: `方案 ${index}`, updatedAt: index }));
  const parsed = parseRecipes(JSON.stringify(many));
  assert.equal(parsed.length, RECIPE_LIMIT);
  assert.equal(parsed[0].id, `r${RECIPE_LIMIT + 9}`);
  assert.deepEqual(parseRecipes("garbage"), []);
  assert.deepEqual(parseRecipes(JSON.stringify([{ id: "x", name: "" }, { id: "y", name: "ok", textTemplate: "hi" }])), [parseRecipes(JSON.stringify([{ id: "y", name: "ok", textTemplate: "hi" }]))[0]]);
  assert.equal(RECIPE_STORAGE_KEY, "knorvia-native-task-recipes");
});

test("upsert and remove keep the list bounded and ids stable", () => {
  let list = [recipe({ id: "a" }), recipe({ id: "b" })];
  list = upsertRecipe(list, recipe({ id: "a", name: "updated" }));
  assert.equal(list.find(item => item.id === "a")?.name, "updated");
  assert.equal(list.length, 2);
  list = removeRecipe(list, "a");
  assert.deepEqual(list.map(item => item.id), ["b"]);
});

test("goal-only variables are required and prototype names remain explicit plain text", () => {
  assert.deepEqual(recipeVariables(recipe({ goal: { criteria: "{{evidence}}", constraints: "{{constructor}} {{__proto__}}" } })), ["module", "focus", "evidence", "constructor", "__proto__"]);
  const result = applyRecipe("{{constructor}}", { criteria: "{{constructor}}", constraints: "{{__proto__}}" }, {});
  assert.equal(result.text, "{{constructor}}"); assert.equal(result.goal?.criteria, "{{constructor}}"); assert.equal(result.goal?.constraints, "{{__proto__}}");
  assert.match(recipeIssue(recipe({ textTemplate: "{{bad variable}}" }))!, /invalid variable/);
  const unfinishedGoal = recipe({ goal: { criteria: "{{not-closed", constraints: "" } });
  assert.match(recipeIssue(unfinishedGoal)!, /invalid variable/);
  assert.equal(recipeIssue(recipe({ textTemplate: "<script>alert('inert')</script>" })), null);
});

test("imports reject oversize and duplicates per item, never evict or claim unsaved additions", () => {
  const current = Array.from({ length: RECIPE_LIMIT }, (_, i) => recipe({ id: `r${i}` }));
  const result = importRecipes(current, [recipe({ id: "overflow" }), recipe({ id: "r1", name: "updated" }), recipe({ id: "r1", name: "duplicate" }), recipe({ id: "bad-goal", goal: { criteria: "x".repeat(4001), constraints: "" } })]);
  assert.equal(result.added.length, 0); assert.equal(result.replaced, 1); assert.equal(result.recipes.length, RECIPE_LIMIT); assert.deepEqual(result.rejected.map(r => r.index), [0, 2, 3]);
  assert.equal(result.recipes.find(r => r.id === "r1")?.name, "updated");
  assert.throws(() => upsertRecipe(current, recipe({ id: "overflow" })), /50-recipe limit/);
  const stripped = importRecipes([], [{ ...recipe(), workspaceId: "secret-project", model: "unexpected", write: true }]).recipes[0];
  assert.equal("workspaceId" in stripped, false); assert.equal("model" in stripped, false); assert.equal("write" in stripped, false);
});
