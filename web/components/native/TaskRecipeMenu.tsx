"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Copy, Download, Library, Pencil, Play, Trash2, Upload } from "lucide-react";
import { applyRecipe, recipeVariables, importRecipes, loadRecipes, removeRecipe, saveRecipes, upsertRecipe, RECIPE_IMPORT_BYTES, RECIPE_STORAGE_KEY, type RecipeGoal, type TaskRecipe } from "@/lib/native-task-recipes";
import { recipeSections, recipeVariableLabel, recipeCopyDraft } from "@/lib/native-domain-recipes";
import { errorText, useWorkbench } from "./NativeWorkbenchProvider";
import { Modal } from "./WorkbenchShell";

type View =
  | { kind: "list" }
  | { kind: "apply"; recipe: TaskRecipe; builtin?: boolean }
  | { kind: "save"; recipe?: TaskRecipe };

/**
 * Reusable text-task work plans (B10). Applying a recipe only fills the
 * composer draft (append or replace, after explicit confirmation) — the menu
 * itself never issues an execution request and never changes project, model,
 * or permission state.
 */
export function TaskRecipeMenu({ currentText, currentGoal, allowGoal = true, onApply, close }: {
  currentText: string;
  currentGoal: RecipeGoal | null;
  allowGoal?: boolean;
  onApply: (resolved: { text: string; goal: RecipeGoal | null }, mode: "append" | "replace") => void;
  close: () => void;
}) {
  const { t, setNotice } = useWorkbench();
  const [recipes, setRecipes] = useState<TaskRecipe[]>(() => loadRecipes());
  const [view, setView] = useState<View>({ kind: "list" });
  const [search, setSearch] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [importResult, setImportResult] = useState("");
  const [error, setError] = useState("");
  const [importing, setImporting] = useState(false);
  const alive = useRef(true);
  const importInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    alive.current = true;
    const changed = (event: StorageEvent) => { if (event.key === RECIPE_STORAGE_KEY || event.key === null) setRecipes(loadRecipes()); };
    window.addEventListener("storage", changed);
    return () => { alive.current = false; window.removeEventListener("storage", changed); };
  }, []);
  const persist = (next: TaskRecipe[]) => {
    if (!saveRecipes(next)) { setError(t("保存失败，现有方案没有更改。请导出或稍后重试。", "Could not save; existing recipes are unchanged. Export or try again.")); return false; }
    setRecipes(next); setError(""); return true;
  };
  const sections = useMemo(() => recipeSections(t, recipes, search), [t, recipes, search]);

  const variables = view.kind === "apply" ? recipeVariables(view.recipe) : [];
  const missing = variables.filter(name => !Object.hasOwn(values, name) || !values[name].trim());
  const resolved = view.kind === "apply" ? applyRecipe(view.recipe.textTemplate, view.recipe.goal, values) : null;
  const textOnlyBuiltin = view.kind === "apply" && view.builtin && !allowGoal;
  const applied = resolved && textOnlyBuiltin ? { ...resolved, goal: null } : resolved;
  const unavailableGoal = Boolean(resolved?.goal && !allowGoal && !textOnlyBuiltin);
  const tooLong = Boolean(resolved && (resolved.text.length > 20000 || (resolved.goal?.criteria.length ?? 0) > 4000 || (resolved.goal?.constraints.length ?? 0) > 4000));
  const cannotApply = missing.length > 0 || unavailableGoal || tooLong;

  const save = (recipe: TaskRecipe) => {
    try {
      const current = loadRecipes();
      if (view.kind === "save" && view.recipe && JSON.stringify(current.find(item => item.id === view.recipe!.id)) !== JSON.stringify(view.recipe)) throw new Error(t("方案已在其他窗口更改，请返回后重新编辑。", "This recipe changed in another window. Go back and reopen it."));
      if (persist(upsertRecipe(current, recipe))) { setView({ kind: "list" }); setNotice(t("方案已保存", "Recipe saved")); }
    } catch (cause) { setError(errorText(cause)); }
  };
  const exportAll = () => {
    try {
      const blob = new Blob([JSON.stringify(loadRecipes(), null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url; anchor.download = "knorvia-task-recipes.json"; anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) { setNotice(errorText(cause)); }
  };
  const importFile = async (file: File) => {
    if (importing) return;
    setImporting(true); setImportResult("");
    try {
      if (file.size > RECIPE_IMPORT_BYTES) throw new Error(t("文件超过 8 MB。", "File exceeds 8 MB."));
      const payload = JSON.parse(await file.text());
      if (!alive.current) return;
      const outcome = importRecipes(loadRecipes(), payload);
      if ((outcome.added.length || outcome.replaced) && !persist(outcome.recipes)) return;
      const parts = [t(`${outcome.added.length} 个新增`, `${outcome.added.length} added`), t(`${outcome.replaced} 个更新`, `${outcome.replaced} replaced`), outcome.rejected.length ? t(`${outcome.rejected.length} 个无效`, `${outcome.rejected.length} invalid`) : ""].filter(Boolean);
      setImportResult(t(`导入结果：${parts.join("、")}。`, `Import result: ${parts.join(", ")}.`) + outcome.rejected.map(item => t(` 第 ${item.index + 1} 项：${item.reason}。`, ` Item ${item.index + 1}: ${item.reason}.`)).join(""));
    } catch (cause) { if (alive.current) setImportResult(t(`导入失败：${errorText(cause)}`, `Import failed: ${errorText(cause)}`)); }
    finally { if (alive.current) setImporting(false); }
  };

  return <Modal title={t("工作方案", "Work plans")} close={() => { close(); }}>
    {error && <p className="nw-help" role="alert">{error}</p>}
    {view.kind === "list" && <>
      <div className="nw-recipe-toolbar">
        <input className="nw-recipe-search" aria-label={t("搜索方案", "Search recipes")} placeholder={t("搜索方案…", "Search recipes…")} value={search} onChange={event => setSearch(event.target.value)} />
        <button className="nw-button nw-button-small" onClick={() => setView({ kind: "save" })}><Library size={13} />{t("保存当前为方案", "Save current as recipe")}</button>
        <button className="nw-button nw-button-small" onClick={exportAll} disabled={!recipes.length}><Download size={13} />{t("导出", "Export")}</button>
        <button className="nw-button nw-button-small" disabled={importing} onClick={() => importInput.current?.click()}><Upload size={13} />{importing ? t("导入中…", "Importing…") : t("导入", "Import")}</button>
        <input ref={importInput} hidden type="file" accept="application/json,.json" onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void importFile(file); }} />
      </div>
      {importResult && <p className="nw-help" role="status">{importResult}</p>}
      {([['learning', t('学习与复习', 'Learning and review')], ['creation', t('创作与表达', 'Creation and communication')], ['mine', t('我的方案', 'My plans')]] as const).map(([group, title]) => sections[group].length > 0 && <section key={group} className="nw-domain-recipe-group" aria-label={title}>
        <h3>{title}</h3><ul className="nw-recipe-list">{sections[group].map(recipe => <li key={recipe.id}>
          <div className="nw-recipe-row">
            <span className="nw-recipe-main"><strong>{recipe.name}</strong><small>{recipe.description}</small></span>
            <button className="nw-button nw-button-small" onClick={() => { setValues({}); setView({ kind: "apply", recipe, builtin: group !== 'mine' }); }}><Play size={12} />{t("应用", "Apply")}</button>
            {group === 'mine' && <button className="nw-icon" aria-label={`${t("编辑方案", "Edit recipe")}: ${recipe.name}`} onClick={() => setView({ kind: "save", recipe })}><Pencil size={13} /></button>}
            <button className="nw-icon" aria-label={`${t("保存副本", "Save a copy")}: ${recipe.name}`} onClick={() => {
              const source = group === 'mine' ? loadRecipes().find(item => item.id === recipe.id) : recipe;
              if (source) save(recipeCopyDraft(source, t, () => crypto.randomUUID()));
              else setError(t("方案已被删除，请重新打开列表。", "The recipe was removed. Reopen the list."));
            }}><Copy size={13} /></button>
            {group === 'mine' && <button className="nw-icon" aria-label={`${t("删除方案", "Delete recipe")}: ${recipe.name}`} onClick={() => persist(removeRecipe(loadRecipes(), recipe.id))}><Trash2 size={13} /></button>}
          </div>
        </li>)}</ul>
      </section>)}
      {!Object.values(sections).some(items => items.length) && <p className="nw-help">{t('没有匹配的方案。', 'No matching plans.')}</p>}
      {!recipes.length && <p className="nw-help">{t("可直接使用上面的内置方案，也可以把自己的任务说明保存为方案。", "Use a built-in plan above or save your own task description for reuse.")}</p>}
    </>}
    {view.kind === "apply" && <>
      <p className="nw-help">{view.recipe.description || view.recipe.name}</p>
      {variables.length > 0 && <fieldset className="nw-recipe-vars"><legend>{t("先填写变量（必填）", "Fill the variables (required)")}</legend>
        {variables.map(name => <label key={name} className="nw-field">{recipeVariableLabel(t, name)}<input maxLength={4000} value={Object.hasOwn(values, name) ? values[name] : ""} onChange={event => setValues(current => ({ ...current, [name]: event.target.value }))} /></label>)}
      </fieldset>}
      {view.recipe.goal && allowGoal && <p className="nw-help">{t("该方案包含目标完成条件，应用后会进入目标模式（可再修改）。", "This recipe carries goal completion criteria; applying it enables goal mode (still editable).")}</p>}
      {textOnlyBuiltin && <p className="nw-help">{t("本次只应用任务正文，当前任务的目标保持原样。", "Only task text will be applied; this task keeps its current goal.")}</p>}
      {unavailableGoal && <p role="alert" className="nw-help">{t("请在首页新任务中应用含目标条件的方案。", "Apply plans with goal criteria from a new task on the home page.")}</p>}
      {tooLong && <p role="alert" className="nw-help">{t("填入变量后内容超出方案上限，请缩短变量。", "The filled plan exceeds its limits. Shorten the variables.")}</p>}
      <details className="nw-recipe-preview" open>
        <summary>{t("应用预览", "Preview")}</summary>
        <pre>{resolved?.text}</pre>
        {applied?.goal && <><strong>{t("完成条件", "Completion criteria")}</strong><pre>{applied.goal.criteria}</pre><strong>{t("约束", "Constraints")}</strong><pre>{applied.goal.constraints}</pre></>}
      </details>
      <p className="nw-help">{t("应用只写入草稿，不会发送任何请求。", "Applying only fills the draft; nothing is sent.")}</p>
      <div className="nw-dialog-actions">
        <button className="nw-button" onClick={() => setView({ kind: "list" })}>{t("返回", "Back")}</button>
        <button className="nw-button" disabled={cannotApply || (applied?.text.length ?? 0) + currentText.length + 2 > 200000} title={missing.length ? t(`未填：${missing.join("、")}`, `Missing: ${missing.join(", ")}`) : undefined} onClick={() => { onApply(applied!, "append"); close(); }}>{t("追加到草稿", "Append to draft")}</button>
        <button className="nw-button nw-button-primary" disabled={cannotApply} title={missing.length ? t(`未填：${missing.join("、")}`, `Missing: ${missing.join(", ")}`) : undefined} onClick={() => { onApply(applied!, "replace"); close(); }}>{t("替换草稿", "Replace draft")}</button>
      </div>
    </>}
    {view.kind === "save" && <form onSubmit={event => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const name = String(form.get("name") ?? "").trim();
      if (!name) return;
      const existing = view.recipe;
      save({
        id: existing?.id ?? (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `recipe-${Date.now()}`),
        name,
        description: String(form.get("description") ?? "").trim(),
        textTemplate: String(form.get("template") ?? ""),
        goal: String(form.get("criteria") ?? "").trim() || String(form.get("constraints") ?? "").trim() ? { criteria: String(form.get("criteria") ?? ""), constraints: String(form.get("constraints") ?? "") } : null,
        createdAt: existing?.createdAt ?? Date.now(),
        updatedAt: Date.now(),
      });
    }}>
      <p className="nw-help">{t("正文中的 {{变量}} 会在应用时要求填写；项目、模型与写权限始终由任务本身决定，不会存入方案。", "{{variables}} in the text are filled at apply time. Project, model, and write permission always come from the task itself and are never stored in a recipe.")}</p>
      <label className="nw-field">{t("方案名称", "Recipe name")}<input name="name" required maxLength={120} defaultValue={view.recipe?.name ?? ""} /></label>
      <label className="nw-field">{t("说明（可选）", "Description (optional)")}<input name="description" maxLength={1000} defaultValue={view.recipe?.description ?? ""} /></label>
      <label className="nw-field">{t("任务正文模板", "Task text template")}<textarea name="template" rows={6} maxLength={20000} defaultValue={view.recipe?.textTemplate ?? currentText} /></label>
      <label className="nw-field">{t("完成条件（可选）", "Completion criteria (optional)")}<textarea name="criteria" rows={2} maxLength={4000} defaultValue={(view.recipe ? view.recipe.goal?.criteria : currentGoal?.criteria) ?? ""} /></label>
      <label className="nw-field">{t("约束（可选）", "Constraints (optional)")}<textarea name="constraints" rows={2} maxLength={4000} defaultValue={(view.recipe ? view.recipe.goal?.constraints : currentGoal?.constraints) ?? ""} /></label>
      <div className="nw-dialog-actions">
        <button type="button" className="nw-button" onClick={() => setView({ kind: "list" })}>{t("返回", "Back")}</button>
        <button className="nw-button nw-button-primary">{t("保存方案", "Save recipe")}</button>
      </div>
    </form>}
  </Modal>;
}
