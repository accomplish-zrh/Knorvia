/**
 * Reusable text-task work plans (B10).
 *
 * A recipe is a named template with {{variable}} placeholders and optional
 * Goal completion criteria/constraints. Applying a recipe only ever fills the
 * composer draft after explicit user confirmation — it never executes a
 * request, never touches project/model/permission state, and imported content
 * stays inert plain text.
 */

export type RecipeGoal = { criteria: string; constraints: string };

export type TaskRecipe = {
  id: string;
  name: string;
  description: string;
  textTemplate: string;
  goal: RecipeGoal | null;
  createdAt: number;
  updatedAt: number;
};

export const RECIPE_STORAGE_KEY = "knorvia-native-task-recipes";
export const RECIPE_LIMIT = 50;
export const RECIPE_IMPORT_BYTES = 8 * 1024 * 1024;
const MAX_NAME = 120;
const MAX_TEXT = 20_000;
const VARIABLE_PATTERN = /\{\{\s*([a-zA-Z0-9_-]{1,40})\s*\}\}/g;

export function extractVariables(template: string): string[] {
  const found: string[] = [];
  for (const match of template.matchAll(VARIABLE_PATTERN)) {
    if (!found.includes(match[1])) found.push(match[1]);
  }
  return found;
}

export function recipeVariables(recipe: Pick<TaskRecipe, "textTemplate" | "goal">): string[] {
  return extractVariables([recipe.textTemplate, recipe.goal?.criteria, recipe.goal?.constraints].filter(Boolean).join("\n"));
}

export function recipeIssue(value: unknown): string | null {
  const item = value as Partial<TaskRecipe> | null;
  if (!item || typeof item !== "object" || typeof item.id !== "string" || !/^[\w-]{1,64}$/.test(item.id)) return "invalid id";
  if (typeof item.name !== "string" || !item.name.trim() || item.name.length > MAX_NAME) return "invalid name";
  if (typeof item.textTemplate !== "string" || item.textTemplate.length > MAX_TEXT) return "invalid or oversized task text";
  if (item.description !== undefined && (typeof item.description !== "string" || item.description.length > 1000)) return "invalid or oversized description";
  if (item.goal != null && (typeof item.goal !== "object" || typeof item.goal.criteria !== "string" || typeof item.goal.constraints !== "string" || item.goal.criteria.length > 4000 || item.goal.constraints.length > 4000)) return "invalid or oversized goal";
  const fields = [item.textTemplate, item.goal?.criteria ?? "", item.goal?.constraints ?? ""];
  if (fields.some(text => /\{\{|\}\}/.test(text.replace(VARIABLE_PATTERN, "")))) return "invalid variable (use {{name}} with letters, digits, _ or -)";
  return null;
}

/** Fill placeholders; unfilled variables are left visible in the text. */
export function applyRecipe(template: string, goal: RecipeGoal | null, values: Record<string, string>): { text: string; goal: RecipeGoal | null } {
  const fill = (text: string) => text.replace(VARIABLE_PATTERN, (whole, name: string) => {
    const value = Object.hasOwn(values, name) ? values[name] : undefined;
    return typeof value === "string" && value.length ? value : whole;
  });
  return {
    text: fill(template),
    goal: goal ? { criteria: fill(goal.criteria), constraints: fill(goal.constraints) } : null,
  };
}

const validRecipe = (value: unknown): TaskRecipe | null => {
  if (recipeIssue(value)) return null;
  const item = value as Partial<TaskRecipe> | null;
  if (!item || typeof item !== "object") return null;
  if (typeof item.id !== "string" || !/^[\w-]{1,64}$/.test(item.id)) return null;
  if (typeof item.name !== "string" || !item.name.trim() || item.name.length > MAX_NAME) return null;
  if (typeof item.textTemplate !== "string" || item.textTemplate.length > MAX_TEXT) return null;
  const description = typeof item.description === "string" ? item.description.slice(0, 1000) : "";
  const goal = item.goal && typeof item.goal === "object"
    && typeof (item.goal as RecipeGoal).criteria === "string" && typeof (item.goal as RecipeGoal).constraints === "string"
    && ((item.goal as RecipeGoal).criteria.trim() || (item.goal as RecipeGoal).constraints.trim())
    ? { criteria: (item.goal as RecipeGoal).criteria.slice(0, 4000), constraints: (item.goal as RecipeGoal).constraints.slice(0, 4000) }
    : null;
  return {
    id: item.id,
    name: item.name.trim(),
    description,
    textTemplate: item.textTemplate,
    goal,
    createdAt: typeof item.createdAt === "number" && Number.isFinite(item.createdAt) ? item.createdAt : 0,
    updatedAt: typeof item.updatedAt === "number" && Number.isFinite(item.updatedAt) ? item.updatedAt : 0,
  };
};

export function parseRecipes(raw: string | null | undefined): TaskRecipe[] {
  let parsed: unknown;
  try { parsed = raw && raw.length <= RECIPE_IMPORT_BYTES ? JSON.parse(raw) : undefined; } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  const recipes: TaskRecipe[] = [];
  const ids = new Set<string>();
  for (const entry of parsed) {
    const recipe = validRecipe(entry);
    if (recipe && !ids.has(recipe.id)) { recipes.push(recipe); ids.add(recipe.id); }
  }
  // Cap AFTER sorting so the newest recipes survive, not the first N seen.
  return recipes.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, RECIPE_LIMIT);
}

export function serializeRecipes(recipes: TaskRecipe[]): string {
  return JSON.stringify(recipes.slice(0, RECIPE_LIMIT));
}

export function upsertRecipe(recipes: TaskRecipe[], recipe: TaskRecipe): TaskRecipe[] {
  const issue = recipeIssue(recipe);
  if (issue) throw new Error(issue);
  const rest = recipes.filter(item => item.id !== recipe.id);
  if (rest.length >= RECIPE_LIMIT) throw new Error("The 50-recipe limit has been reached; remove one before adding another");
  return [{ ...recipe, updatedAt: Date.now() }, ...rest];
}

export function removeRecipe(recipes: TaskRecipe[], id: string): TaskRecipe[] {
  return recipes.filter(item => item.id !== id);
}

export type ImportOutcome = { added: TaskRecipe[]; replaced: number; rejected: { index: number; reason: string }[]; recipes: TaskRecipe[] };

/** Per-item import: conflicting ids replace the stored recipe, bad ones are rejected with a reason. */
export function importRecipes(current: TaskRecipe[], payload: unknown): ImportOutcome {
  const outcome: ImportOutcome = { added: [], replaced: 0, rejected: [], recipes: current };
  if (!Array.isArray(payload)) return { ...outcome, rejected: [{ index: 0, reason: "not a list" }] };
  if (payload.length > 200) return { ...outcome, rejected: [{ index: 0, reason: "import list exceeds 200 entries" }] };
  const working = [...current];
  const seen = new Set<string>();
  payload.forEach((entry, index) => {
    const recipe = validRecipe(entry);
    if (!recipe) {
      outcome.rejected.push({ index, reason: recipeIssue(entry) ?? "invalid" });
      return;
    }
    if (seen.has(recipe.id)) { outcome.rejected.push({ index, reason: "duplicate id in this import" }); return; }
    seen.add(recipe.id);
    const existingIndex = working.findIndex(item => item.id === recipe.id);
    if (existingIndex >= 0) {
      working[existingIndex] = { ...recipe, updatedAt: Date.now() };
      outcome.replaced += 1;
    } else {
      if (working.length >= RECIPE_LIMIT) { outcome.rejected.push({ index, reason: "50-recipe limit reached" }); return; }
      working.push(recipe);
      outcome.added.push(recipe);
    }
  });
  outcome.recipes = working;
  return outcome;
}

// --- local storage ------------------------------------------------------------

const hasStorage = () => typeof localStorage !== "undefined";

export function loadRecipes(): TaskRecipe[] {
  if (!hasStorage()) return [];
  try { return parseRecipes(localStorage.getItem(RECIPE_STORAGE_KEY)); } catch { return []; }
}

export function saveRecipes(recipes: TaskRecipe[]): boolean {
  if (!hasStorage()) return false;
  try { localStorage.setItem(RECIPE_STORAGE_KEY, serializeRecipes(recipes)); return true; } catch { return false; }
}
