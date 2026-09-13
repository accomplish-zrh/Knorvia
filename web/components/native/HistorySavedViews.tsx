"use client";

import { useEffect, useRef, useState } from "react";
import { Save, Trash2, View } from "lucide-react";
import { HISTORY_VISIBLE_DEFAULT, HISTORY_VIEWS_LIMIT, loadHistoryViews, persistHistoryViews, upsertHistoryView, type HistoryViewConfig } from "@/lib/native-history-views";
import { useWorkbench } from "./NativeWorkbenchProvider";

/**
 * Named history views (B15): apply switches the filter projection; switching
 * is blocked while a bulk run holds the selection lock, and applying never
 * restores a selection set.
 */
export function HistorySavedViews({ activeViewId, onApply, onActiveDeleted, disabled, filter, projectId, dateRange, query, visible }: {
  activeViewId: string | null;
  onApply: (view: HistoryViewConfig) => void;
  onActiveDeleted: () => void;
  disabled: boolean;
  filter: string;
  projectId: string;
  dateRange: string;
  query: string;
  visible: number;
}) {
  const { t, setNotice } = useWorkbench();
  const [open, setOpen] = useState(false);
  const [views, setViews] = useState<HistoryViewConfig[]>(() => loadHistoryViews());
  const [naming, setNaming] = useState<"new" | "edit" | false>(false);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  // Cross-window: the list refreshes, but the caller's active filters never
  // change underneath a running interaction.
  useEffect(() => {
    const storage = (event: StorageEvent) => { if (event.key === "knorvia-native-history-views") setViews(loadHistoryViews()); };
    window.addEventListener("storage", storage);
    return () => window.removeEventListener("storage", storage);
  }, []);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!container.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); setOpen(false); trigger.current?.focus({ preventScroll: true }); } };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape, true);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape, true); };
  }, [open]);

  const save = (name: string) => {
    if (disabled) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    const stored = loadHistoryViews();
    const existing = naming === "edit" && activeViewId ? stored.find(view => view.id === activeViewId) : undefined;
    if (naming === "edit" && !existing) { setNotice(t('视图已被删除，当前筛选仍保留。', 'The view was deleted; your current filters are kept.')); return; }
    if (!existing && stored.length >= HISTORY_VIEWS_LIMIT) { setNotice(t('最多保存 30 个视图，请先删除不再使用的视图。', 'You can save up to 30 views. Remove an unused view first.')); return; }
    const next = upsertHistoryView(stored, {
      id: existing?.id ?? (crypto.randomUUID ? crypto.randomUUID() : `view-${Date.now()}`),
      name: trimmed,
      filter: filter as HistoryViewConfig["filter"],
      projectId,
      dateRange: dateRange as HistoryViewConfig["dateRange"],
      query,
      visible: Math.max(HISTORY_VISIBLE_DEFAULT, visible),
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
    });
    if (!persistViews(next)) return;
    setNotice(t(`视图「${trimmed}」已保存`, `View "${trimmed}" saved`));
    setNaming(false);
    onApply(next[0]); setOpen(false);
  };
  const persistViews = (next: HistoryViewConfig[]) => {
    if (disabled) return false;
    if (!persistHistoryViews(next)) { setNotice(t('视图未保存，本地存储不可用。', 'View changes were not saved: local storage is unavailable.')); return false; }
    setViews(next); return true;
  };

  const activeName = activeViewId ? views.find(view => view.id === activeViewId)?.name : undefined;
  return <div className="nw-views" ref={container}>
    <button ref={trigger} className="nw-button" aria-expanded={open} aria-haspopup="dialog" disabled={disabled} onClick={() => setOpen(value => !value)}><View size={15} />{activeName ? t(`视图：${activeName}`, `View: ${activeName}`) : t("命名视图", "Named views")}</button>
    {open && <div className="nw-views-panel" role="dialog" aria-label={t("命名视图", "Named views")}>
      <ul className="nw-views-list">
        {views.map(view => <li key={view.id}>
          <span className="nw-views-main"><strong>{view.name}</strong><small>{t(`${view.filter} · ${view.dateRange}`, `${view.filter} · ${view.dateRange}`)}{view.projectId !== "all" ? t(" · 单项目", " · project") : ""}</small></span>
          <button className="nw-button nw-button-small" disabled={disabled} onClick={() => { onApply(view); setOpen(false); }}>{t("应用", "Apply")}</button>
          <button className="nw-icon" disabled={disabled} aria-label={`${t("删除视图", "Delete view")}: ${view.name}`} onClick={() => { if (persistViews(loadHistoryViews().filter(item => item.id !== view.id)) && view.id === activeViewId) onActiveDeleted(); }}><Trash2 size={13} /></button>
        </li>)}
      </ul>
      {!views.length && <p className="nw-help">{t("还没有命名视图。调整筛选后保存，可一键回到同一范围。", "No named views yet. Set filters and save them for one-click return.")}</p>}
      {naming ? <form className="nw-views-save" onSubmit={event => { event.preventDefault(); save(new FormData(event.currentTarget).get("name") as string); }}>
        <input name="name" autoFocus required disabled={disabled} maxLength={80} defaultValue={naming === "edit" ? activeName : ''} aria-label={t("视图名称", "View name")} placeholder={t("例如：项目A最近的失败", "e.g. Project A recent failures")} />
        <button className="nw-button nw-button-small" disabled={disabled}>{t("保存", "Save")}</button>
        <button type="button" className="nw-button nw-button-small" onClick={() => setNaming(false)}>{t("取消", "Cancel")}</button>
      </form>
        : <><button className="nw-button nw-button-small" disabled={disabled} onClick={() => setNaming("new")}><Save size={13} />{t("把当前筛选存为视图", "Save current filters as a view")}</button>{activeName && <button className="nw-button nw-button-small" disabled={disabled} onClick={() => setNaming("edit")}>{t('更新当前视图', 'Update current view')}</button>}</>}
    </div>}
  </div>;
}
