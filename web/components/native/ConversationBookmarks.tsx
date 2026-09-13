"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { BookmarkCheck, Download, MapPin, Trash2 } from "lucide-react";
import { bookmarksForThread, exportExcerpts, loadBookmarks, locatePlan, removeBookmark, saveBookmarks, searchBookmarks, sourceChanged, updateBookmarkNote, type ConversationBookmark } from "@/lib/native-conversation-bookmarks";
import type { ThreadSnapshot } from "@/lib/native-workbench-state";
import { itemText } from "@/lib/native-workbench-state";
import { errorText, useWorkbench } from "./NativeWorkbenchProvider";
import { Modal } from "./WorkbenchShell";

/** Bounded backward reads while hunting for a bookmarked item. */
const MAX_LOCATE_READS = 5;

/**
 * Per-thread bookmark list (B11): search, locate (mounting the timeline chunk
 * or loading bounded older pages first), annotate, remove, and export sourced
 * excerpts. Removing a bookmark never touches the message itself.
 */
export function ConversationBookmarks({ thread, open, close, navigate }: {
  thread: ThreadSnapshot; open: boolean; close: () => void; navigate: () => void;
}) {
  const { t, readThread, setNotice } = useWorkbench();
  const [store, setStore] = useState<ConversationBookmark[]>(() => {
    return loadBookmarks();
  });
  const [query, setQuery] = useState("");
  const [loadingId, setLoadingId] = useState("");
  const [editing, setEditing] = useState("");
  const list = useMemo(() => searchBookmarks(bookmarksForThread(store, thread.id), query), [store, thread.id, query]);
  const [reloadTick, setReloadTick] = useState(0);
  const locateScope = useRef({ key: "", generation: 0 });
  const scopeKey = `${thread.id}:${open}`;
  if (locateScope.current.key !== scopeKey) { locateScope.current.key = scopeKey; locateScope.current.generation += 1; }
  useEffect(() => () => { locateScope.current.generation += 1; }, []);
  useEffect(() => {
    if (!open) return;
    const refresh = () => setStore(loadBookmarks());
    refresh();
    window.addEventListener("storage", refresh);
    return () => window.removeEventListener("storage", refresh);
  }, [open, thread.id]);

  const persist = (next: ConversationBookmark[]) => {
    if (!saveBookmarks(next)) { setNotice(t("书签更改未保存，本地存储不可用。", "Bookmark changes were not saved: local storage is unavailable.")); return; }
    setStore(next);
  };

  const locate = async (bookmark: ConversationBookmark) => {
    if (bookmark.threadId !== thread.id || !open) return;
    const generation = ++locateScope.current.generation;
    const current = () => locateScope.current.key === scopeKey && locateScope.current.generation === generation;
    let snapshot = thread;
    for (let attempt = 0; attempt <= MAX_LOCATE_READS; attempt += 1) {
      if (!current()) return;
      const plan = locatePlan(snapshot, bookmark);
      if (plan.kind === "mounted") {
        navigate();
        // The timeline mounts the matching chunk and scrolls on this event.
        // readThread updates React state asynchronously. Let the new snapshot
        // commit before asking its timeline to mount the matching chunk.
        requestAnimationFrame(() => requestAnimationFrame(() => {
          if (!current()) return;
          window.dispatchEvent(new CustomEvent("knorvia:locate-timeline-item", { detail: { id: bookmark.itemId, threadId: bookmark.threadId, scroll: true } }));
          close();
        }));
        const changed = sourceChanged(bookmark, (() => {
          const item = snapshot.items.find(entry => entry.id === bookmark.itemId);
          return item ? itemText(item) : undefined;
        })());
        if (changed) setNotice(t("已定位，但原文与书签创建时不同。", "Located, but the source text changed since the bookmark was created."));
        return;
      }
      if (plan.kind === "unreachable") {
        setNotice(plan.reason === "complete-without-match"
          ? t("已加载全部保留的记录，仍未找到原文；该记录可能已超出保留范围。", "All retained history loaded without a match; the record may be out of retention.")
          : t("当前无法读取更多历史，暂不能定位原文。", "Older history is not reachable right now; the source cannot be located yet."));
        return;
      }
      if (attempt === MAX_LOCATE_READS) break;
      setLoadingId(bookmark.id);
      try { snapshot = await readThread(thread.id, plan.cursor); }
      catch (error) { if (current()) setNotice(errorText(error)); return; }
      finally { if (current()) setLoadingId(""); }
    }
    if (!current()) return;
    setNotice(t(`连续读取 ${MAX_LOCATE_READS} 页仍未到达该书签位置。`, `Reads stopped after ${MAX_LOCATE_READS} bounded pages without reaching the bookmark.`));
    setReloadTick(tick => tick + 1);
  };

  const exportAll = () => {
    try {
      const content = exportExcerpts(thread.title, list);
      const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url; anchor.download = `knorvia-excerpts-${thread.id.slice(0, 8)}.md`; anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) { setNotice(errorText(error)); }
  };

  if (!open) return null;
  void reloadTick;
  return <Modal title={t("书签与摘录", "Bookmarks and excerpts")} close={close}>
    <div className="nw-bookmark-toolbar">
      <input className="nw-recipe-search" aria-label={t("搜索书签", "Search bookmarks")} placeholder={t("搜索摘录或备注…", "Search excerpts or notes…")} value={query} onChange={event => setQuery(event.target.value)} />
      <button className="nw-button nw-button-small" disabled={!list.length} onClick={exportAll}><Download size={13} />{t("导出带出处摘录", "Export sourced excerpts")}</button>
    </div>
    <ul className="nw-bookmark-list">
      {list.map(bookmark => {
        const plan = locatePlan(thread, bookmark);
        const changed = plan.kind === "mounted" ? sourceChanged(bookmark, (() => {
          const item = thread.items.find(entry => entry.id === bookmark.itemId);
          return item ? itemText(item) : undefined;
        })()) : null;
        return <li key={bookmark.id} className="nw-bookmark-item">
          <blockquote>{bookmark.excerpt}</blockquote>
          {bookmark.note && <p className="nw-bookmark-note">{t("备注", "Note")}: {bookmark.note}</p>}
          <div className="nw-bookmark-meta">
            <small>{t(`seq ${bookmark.seq}`, `seq ${bookmark.seq}`)} · <code>{bookmark.fingerprint}</code></small>
            {changed === true && <span className="nw-bookmark-flag" role="note">{t("原文已变化", "source changed")}</span>}
            {plan.kind === "unreachable" && <span className="nw-bookmark-flag" role="note">{t("暂不可达", "unreachable")}</span>}
          </div>
          {editing === bookmark.id ? <div className="nw-bookmark-edit"><textarea aria-label={t("编辑备注", "Edit note")} maxLength={500} rows={3} defaultValue={bookmark.note} onKeyDown={event => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); persist(updateBookmarkNote(store, bookmark.id, (event.target as HTMLTextAreaElement).value)); setEditing(""); } }} /><button className="nw-button nw-button-small" onClick={event => { const input = (event.currentTarget.previousElementSibling as HTMLTextAreaElement); persist(updateBookmarkNote(store, bookmark.id, input.value)); setEditing(""); }}>{t("保存备注", "Save note")}</button></div>
            : <div className="nw-bookmark-actions">
              <button className="nw-button nw-button-small" disabled={loadingId === bookmark.id} onClick={() => void locate(bookmark)}><MapPin size={12} />{loadingId === bookmark.id ? t("定位中…", "Locating…") : plan.kind === "paged" ? t("加载并定位", "Load and locate") : t("定位原文", "Locate source")}</button>
              <button className="nw-button nw-button-small" onClick={() => setEditing(bookmark.id)}><BookmarkCheck size={12} />{t("备注", "Note")}</button>
              <button className="nw-icon" aria-label={t("删除书签", "Remove bookmark")} onClick={() => persist(removeBookmark(store, bookmark.id))}><Trash2 size={13} /></button>
            </div>}
        </li>;
      })}
    </ul>
    {!list.length && <p className="nw-help">{t("还没有书签。在消息下方的书签按钮可以把关键结论固定下来。", "No bookmarks yet. Use the bookmark button under a message to pin a key conclusion.")}</p>}
  </Modal>;
}
