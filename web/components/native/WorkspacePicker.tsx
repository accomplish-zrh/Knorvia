"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ArrowUpRight, Check, ChevronDown, Folder, FolderOpen, Plus, Search, X } from "lucide-react";
import type { Workspace } from "@/lib/native-workbench-state";
import { useWorkbench } from "./NativeWorkbenchProvider";
import { ProjectDialog } from "./WorkbenchShell";
import "./workspace-picker.css";

export function WorkspacePicker({ workspace, cwd, locked = false, disabled = false }: {
  workspace?: Workspace;
  cwd?: string | null;
  locked?: boolean;
  disabled?: boolean;
}) {
  const { t, workspaces, workspaceId, setWorkspaceId, connection } = useWorkbench();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const id = useId();
  const selectedId = workspace?.id ?? workspaceId;
  const normalize = (value: string) => value.toLocaleLowerCase().replaceAll("\\", "/");
  const needle = normalize(query.trim());
  const results = workspaces.filter(item => normalize(item.title + " " + (item.cwd ?? "")).includes(needle));
  const activeIndex = Math.min(active, results.length - 1);
  const folder = cwd ?? workspace?.cwd;

  const dismiss = useCallback((restoreFocus = false) => {
    popup.current?.hidePopover();
    if (restoreFocus) trigger.current?.focus({ preventScroll: true });
  }, []);

  // The native top layer avoids scroll-container clipping and retains the theme.
  // Keep it within the visual viewport, including an on-screen keyboard.
  const position = useCallback(() => {
    const panel = popup.current;
    const button = trigger.current;
    if (!panel || !button || !panel.matches(":popover-open")) return;
    const viewport = window.visualViewport;
    const leftEdge = (viewport?.offsetLeft ?? 0) + 12;
    const topEdge = (viewport?.offsetTop ?? 0) + 12;
    const width = Math.min(360, (viewport?.width ?? window.innerWidth) - 24);
    const bottomEdge = topEdge + (viewport?.height ?? window.innerHeight) - 24;
    const anchor = button.getBoundingClientRect();
    if (anchor.bottom < topEdge || anchor.top > bottomEdge) { dismiss(); return; }
    const below = bottomEdge - anchor.bottom - 8;
    const above = anchor.top - topEdge - 8;
    const list = panel.querySelector<HTMLElement>(".nw-workspace-list");
    const desiredHeight = Math.min(400, panel.scrollHeight - (list?.clientHeight ?? 0) + (list?.scrollHeight ?? 0));
    const down = below >= desiredHeight || (above < desiredHeight && below >= above);
    const height = Math.max(80, Math.min(400, down ? below : above, bottomEdge - topEdge));
    panel.style.width = width + "px";
    panel.style.maxHeight = height + "px";
    panel.style.left = Math.max(leftEdge, Math.min(anchor.left, leftEdge + (viewport?.width ?? window.innerWidth) - 24 - width)) + "px";
    panel.style.top = (down ? Math.min(anchor.bottom + 8, bottomEdge - panel.offsetHeight) : Math.max(topEdge, anchor.top - 8 - panel.offsetHeight)) + "px";
  }, [dismiss]);

  useEffect(() => {
    if (!open) return;
    position();
    const scrolled = (event: Event) => {
      if (event.target instanceof Node && popup.current?.contains(event.target)) return;
      position();
    };
    const observer = new ResizeObserver(position);
    if (popup.current) observer.observe(popup.current);
    if (trigger.current) observer.observe(trigger.current);
    window.addEventListener("resize", position);
    document.addEventListener("scroll", scrolled, true);
    window.visualViewport?.addEventListener("resize", position);
    window.visualViewport?.addEventListener("scroll", position);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", position);
      document.removeEventListener("scroll", scrolled, true);
      window.visualViewport?.removeEventListener("resize", position);
      window.visualViewport?.removeEventListener("scroll", position);
    };
  }, [open, position]);

  useEffect(() => {
    if (!open) return;
    popup.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, query, open]);
  useEffect(() => { if (disabled || locked) dismiss(); }, [disabled, locked, dismiss]);

  const choose = (item: Workspace) => {
    if (disabled || locked) return;
    setWorkspaceId(item.id);
    dismiss(true);
  };
  const prepare = () => {
    setQuery("");
    setActive(Math.max(0, workspaces.findIndex(item => item.id === selectedId)));
  };

  if (locked) return <span className="nw-workspace-locked" title={folder ?? undefined}>
    <Folder size={14} strokeWidth={1.7} aria-hidden="true" />
    <span>{workspace?.title ?? t("当前工作区", "Current workspace")}</span>
  </span>;

  return <div className="nw-workspace-picker">
    <button ref={trigger} type="button" className="nw-workspace-trigger" disabled={disabled}
      popoverTarget={id} aria-haspopup="dialog" aria-expanded={open} aria-controls={id}
      aria-label={t("选择工作区", "Choose workspace")} title={folder ?? workspace?.title}
      onClick={prepare}
      onKeyDown={event => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault(); prepare(); popup.current?.showPopover();
        }
      }}>
      <Folder size={14} strokeWidth={1.7} aria-hidden="true" />
      <span>{workspace?.title ?? t("选择工作区", "Choose workspace")}</span>
      <ChevronDown size={12} strokeWidth={1.7} aria-hidden="true" />
    </button>
    <div ref={popup} id={id} popover="auto" role="dialog" aria-labelledby={id + "-heading"}
      className="nw-workspace-popover"
      onToggle={event => {
        const visible = event.newState === "open";
        setOpen(visible);
        if (visible) requestAnimationFrame(() => {
          position();
          search.current?.focus({ preventScroll: true });
        });
      }}
      onKeyDown={event => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); dismiss(true); }
      }}
      onBlur={event => {
        if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget) && event.relatedTarget !== trigger.current) dismiss();
      }}>
      <div className="nw-workspace-heading">
        <h3 id={id + "-heading"}>{t("选择工作区", "Choose workspace")}</h3>
        <kbd aria-hidden="true">{t("Esc", "Esc")}</kbd>
      </div>
      <div className="nw-workspace-search">
        <Search size={15} strokeWidth={1.7} aria-hidden="true" />
        <input ref={search} role="combobox" autoComplete="off" spellCheck={false}
          aria-label={t("搜索工作区", "Search workspaces")} aria-autocomplete="list"
          aria-expanded={open} aria-controls={id + "-list"}
          aria-activedescendant={activeIndex >= 0 ? id + "-option-" + activeIndex : undefined}
          placeholder={t("搜索名称或文件夹路径…", "Search names or folder paths…")}
          value={query} onChange={event => { setQuery(event.target.value); setActive(0); }}
          onKeyDown={event => {
            if (event.nativeEvent.isComposing) return;
            if ((event.key === "ArrowDown" || event.key === "ArrowUp") && results.length) {
              event.preventDefault();
              setActive((activeIndex + (event.key === "ArrowDown" ? 1 : -1) + results.length) % results.length);
            } else if (event.key === "Enter" && results[activeIndex]) {
              event.preventDefault(); choose(results[activeIndex]);
            }
          }} />
        {query && <button type="button" className="nw-workspace-clear"
          aria-label={t("清空工作区搜索", "Clear workspace search")}
          onClick={() => { setQuery(""); setActive(0); search.current?.focus(); }}><X size={13} /></button>}
      </div>
      <div className="nw-workspace-caption">
        <span>{needle ? t("搜索结果", "Search results") : t("全部工作区", "All workspaces")}</span>
        <span role="status">{results.length}{t(" 个", "")}</span>
      </div>
      <div id={id + "-list"} role="listbox" aria-label={t("工作区", "Workspaces")} className="nw-workspace-list">
        {results.map((item, index) => <button key={item.id} type="button"
          id={id + "-option-" + index} role="option" aria-selected={item.id === selectedId}
          data-active={index === activeIndex} tabIndex={-1} className="nw-workspace-option"
          title={item.cwd ?? item.title} onPointerMove={() => setActive(index)}
          onPointerDown={event => event.preventDefault()} onClick={() => choose(item)}>
          <span className="nw-workspace-folder"><FolderOpen size={17} strokeWidth={1.6} aria-hidden="true" /></span>
          <span className="nw-workspace-description"><strong>{item.title}</strong>
            <small dir="auto">{item.cwd || t("文件由 Knorvia 管理", "Files managed by Knorvia")}</small></span>
          {item.id === selectedId && <Check className="nw-workspace-check" size={15} strokeWidth={2} aria-hidden="true" />}
        </button>)}
        {!results.length && <div className="nw-workspace-empty">
          {needle ? <Search size={23} strokeWidth={1.4} aria-hidden="true" /> : <FolderOpen size={23} strokeWidth={1.4} aria-hidden="true" />}
          <strong>{needle ? t("没有找到工作区", "No matching workspaces") : t("从一个工作区开始", "Start with a workspace")}</strong>
          <p>{needle ? t("换个名称或文件夹路径试试。", "Try another name or folder path.") : t("把资料和任务放在一起，随时继续。", "Keep files and tasks together, ready to continue.")}</p>
        </div>}
      </div>
      <div className="nw-workspace-footer">
        <button type="button" className="nw-workspace-create" disabled={connection !== "connected"}
          onClick={() => { dismiss(true); setCreating(true); }}>
          <Plus size={16} strokeWidth={1.7} aria-hidden="true" />
          <span>{t("新建工作区", "New workspace")}</span>
          <ArrowUpRight size={14} strokeWidth={1.6} aria-hidden="true" />
        </button>
      </div>
    </div>
    {creating && <ProjectDialog close={() => { setCreating(false); trigger.current?.focus(); }} />}
  </div>;
}
