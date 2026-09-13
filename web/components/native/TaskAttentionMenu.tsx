"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { BellRing, ChevronRight } from "lucide-react";
import type { Workspace } from "@/lib/native-workbench-state";
import { ATTENTION_LIST_LIMIT, attentionLabel, collectTaskAttention } from "@/lib/native-task-attention";
import { useWorkbench } from "./NativeWorkbenchProvider";
import { StatusLabel } from "./WorkbenchShell";

/**
 * Persistent cross-project attention entry in the top bar (B05). Counts come
 * from the thread index snapshots, so handling a task (approval, input)
 * updates them on the next authoritative read — never from stream text.
 */
export function TaskAttentionMenu() {
  const { t, threads, threadIndexComplete, workspaces } = useWorkbench();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const { counts, items } = useMemo(() => collectTaskAttention(threads), [threads]);
  const projectNames = useMemo(() => new Map(workspaces.map(project => [project.id, project.title])), [workspaces]);
  const visible = items.slice(0, ATTENTION_LIST_LIMIT);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!containerRef.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus({ preventScroll: true });
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape, true);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape, true); };
  }, [open]);

  const openTask = (id: string) => {
    setOpen(false);
    triggerRef.current?.focus({ preventScroll: true });
    router.push(`/workbench/task/${encodeURIComponent(id)}`);
  };

  return <div className="nw-attention" ref={containerRef}>
    <button ref={triggerRef} className="nw-icon nw-attention-trigger" aria-expanded={open} aria-haspopup="dialog" aria-controls={panelId} aria-label={attentionLabel(counts, t)} onClick={() => setOpen(value => !value)} data-has-attention={counts.total > 0 || undefined}>
      <BellRing size={17} />
      {counts.total > 0 && <span className="nw-attention-badge" aria-hidden>{counts.total > 99 ? "99+" : counts.total}</span>}
    </button>
    {open && <div id={panelId} role="dialog" aria-label={t("等待你的任务", "Tasks waiting for you")} className="nw-attention-panel">
      <div className="nw-attention-head"><strong>{t("等待你的任务", "Tasks waiting for you")}</strong><span>{attentionLabel(counts, t)}</span></div>
      {!threadIndexComplete && <p className="nw-attention-note" role="note">{t("任务索引还在读取，列表可能不是全部；完成后会自动更新。", "The task index is still loading; this list may be incomplete until it finishes.")}</p>}
      {visible.map(item => <button key={item.id} className="nw-attention-item" onClick={() => openTask(item.id)}>
        <span className="nw-attention-item-main"><strong>{item.title}</strong><small>{projectNames.get(item.workspaceId) ?? t("其他项目", "Other project")}</small></span>
        <StatusLabel status={item.status} />
        <ChevronRight size={14} />
      </button>)}
      {items.length > visible.length && <p className="nw-attention-note">{t(`还有 ${items.length - visible.length} 项，请打开对应项目查看。`, `${items.length - visible.length} more; open the project to see them.`)}</p>}
      {counts.total === 0 && <p className="nw-attention-empty">{threadIndexComplete ? t("没有等待你的任务。", "Nothing is waiting for you.") : t("索引读取中——即使这里为空，也不代表全局没有待处理任务。", "The index is still loading — an empty list here is not a global all-clear.")}</p>}
    </div>}
  </div>;
}
