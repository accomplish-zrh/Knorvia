import test from 'node:test';
import assert from 'node:assert/strict';
import { builtinTaskRecipes, recipeSections, recipeCopyDraft, recipeVariableLabel } from '../lib/native-domain-recipes';
import { applyRecipe, recipeIssue, recipeVariables, upsertRecipe, RECIPE_LIMIT, type TaskRecipe } from '../lib/native-task-recipes';

const zh = (a: string, _b: string) => a;
const en = (_a: string, b: string) => b;

test('both languages produce six valid plans with resolvable variables and criteria', () => {
  for (const translate of [zh, en]) {
    const recipes = builtinTaskRecipes(translate);
    assert.equal(recipes.length, 6);
    assert.equal(new Set(recipes.map(item => item.id)).size, 6);
    for (const recipe of recipes) {
      assert.equal(recipeIssue(recipe), null, recipe.id);
      const names = recipeVariables(recipe);
      assert.ok(names.length > 0);
      const filled = applyRecipe(recipe.textTemplate, recipe.goal, Object.fromEntries(names.map(name => [name, `value-${name}`])));
      assert.equal(recipeVariables({ textTemplate: filled.text, goal: filled.goal }).length, 0);
      assert.ok(filled.goal?.criteria && filled.goal?.constraints);
      for (const name of names) assert.notEqual(recipeVariableLabel(translate, name), name);
    }
  }
});

test('search matches each preset independently, also across languages', () => {
  const all = recipeSections(zh, [], '');
  assert.equal(all.learning.length, 3);
  assert.equal(all.creation.length, 3);
  const storyboard = recipeSections(zh, [], 'Video storyboard');
  assert.equal(storyboard.creation.length, 1);
  assert.equal(storyboard.learning.length, 0);
  assert.equal(storyboard.creation[0].id, 'builtin-video-storyboard');
  assert.deepEqual(recipeSections(en, [], 'this matches no plan at all'), { learning: [], creation: [], mine: [] });
});

test('built-ins stay independent from the fifty saved plans and copies use new identities', () => {
  const builtin = builtinTaskRecipes(zh)[0];
  const custom: TaskRecipe[] = Array.from({ length: RECIPE_LIMIT }, (_, index) => ({ ...builtin, id: `mine-${index}` }));
  const snapshot = JSON.stringify(custom);
  const groups = recipeSections(zh, custom, '');
  assert.equal(groups.mine.length, 50);
  assert.equal(groups.learning.length + groups.creation.length, 6);
  const copy = recipeCopyDraft(builtin, zh, () => 'my-copy');
  assert.equal(copy.id, 'my-copy');
  assert.throws(() => upsertRecipe(custom, copy), /50/);
  assert.equal(JSON.stringify(custom), snapshot);
  assert.equal(upsertRecipe([], copy)[0].id, 'my-copy');
  assert.equal(builtin.id, builtinTaskRecipes(zh)[0].id);
});
