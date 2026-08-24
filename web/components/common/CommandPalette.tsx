"use client";

/**
 * Cmd+K command palette (zero-dependency, LobeChat/Open WebUI parity).
 *
 * Aggregates: workspace navigation, the three creation desks, and live
 * session search (deep FTS via /sessions/search). Open with Ctrl/Cmd+K.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslation } from "react-i18next";
import {
  BookOpen,
  Clapperboard,
  CornerDownLeft,
  FileEdit,
  Home,
  Images,
  LayoutGrid,
  MessageSquarePlus,
  MessagesSquare,
  Search,
} from "lucide-react";
import { searchSessions } from "@/lib/session-api";

interface CommandItem {
  id: string;
  label: string;
  hint?: string;
  icon: React.ComponentType<{ size?: number | string; className?: string }>;
  run: () => void;
  group: "nav" | "create" | "session";
}

interface SessionHit {
  session_id: string;
  title: string;
}

export default function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const [sessionHits, setSessionHits] = useState<SessionHit[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // Reset fields when the palette opens: derive from `open` during render
  // (React docs pattern) rather than setState inside an effect.
  const [wasOpen, setWasOpen] = useState(false);
  if (open && !wasOpen) {
    setWasOpen(true);
    setQuery("");
    setActiveIdx(0);
    setSessionHits([]);
  } else if (!open && wasOpen) {
    setWasOpen(false);
  }
  useEffect(() => {
    if (open) {
      const timer = window.setTimeout(() => inputRef.current?.focus(), 10);
      return () => window.clearTimeout(timer);
    }
  }, [open]);

  const go = useCallback(
    (href: string) => {
      onClose();
      router.push(href);
    },
    [onClose, router],
  );

  // Session deep-search, debounced.
  useEffect(() => {
    if (!open) return;
    const keyword = query.trim();
    if (keyword.length < 2) {
      // Clear asynchronously (post-render) to satisfy the set-state-in-effect
      // lint rule; an empty-hit frame is indistinguishable from a cleared one.
      const id = window.setTimeout(() => setSessionHits([]), 0);
      return () => window.clearTimeout(id);
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      searchSessions(keyword, 6, controller.signal)
        .then(hits =>
          setSessionHits(
            hits.map(h => ({ session_id: h.session_id, title: h.title })),
          ),
        )
        .catch(() => {});
    }, 200);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [query, open]);

  const commands: CommandItem[] = useMemo(() => {
    const nav: CommandItem[] = [
      { id: "nav-home", label: t("New chat"), icon: MessageSquarePlus, group: "create", run: () => go("/") },
      { id: "nav-co-writer", label: t("Co-Writer"), icon: FileEdit, group: "create", run: () => go("/co-writer") },
      { id: "nav-image", label: t("Image Studio"), icon: Images, group: "create", run: () => go("/image-studio") },
      { id: "nav-video", label: t("Video Studio"), icon: Clapperboard, group: "create", run: () => go("/video-studio") },
      { id: "nav-knowledge", label: t("Knowledge Center"), icon: BookOpen, group: "nav", run: () => go("/knowledge") },
      { id: "nav-space", label: t("Space"), icon: LayoutGrid, group: "nav", run: () => go("/space") },
      { id: "nav-history", label: t("Chat history"), icon: MessagesSquare, group: "nav", run: () => go("/space/chat-history") },
      { id: "nav-settings", label: t("Settings"), icon: Home, group: "nav", run: () => go("/settings/status") },
    ];
    const sessions: CommandItem[] = sessionHits.map(hit => ({
      id: `session-${hit.session_id}`,
      label: hit.title || t("Untitled session"),
      icon: MessagesSquare,
      group: "session" as const,
      run: () => go(`/?session=${encodeURIComponent(hit.session_id)}`),
    }));
    return [...nav, ...sessions];
  }, [go, sessionHits, t]);

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return commands.filter(c => c.group !== "session");
    return commands.filter(c => c.label.toLowerCase().includes(keyword));
  }, [commands, query]);

  // Reset the highlighted row during render when the result set changes
  // (derived-state adjustment per React docs) instead of in an effect.
  const [lastFilterKey, setLastFilterKey] = useState("");
  const filterKey = `${query}|${filtered.length}`;
  if (filterKey !== lastFilterKey) {
    setLastFilterKey(filterKey);
    setActiveIdx(0);
  }

  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${activeIdx}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIdx, open]);

  const execute = useCallback(
    (item?: CommandItem) => {
      if (!item) return;
      onClose();
      item.run();
    },
    [onClose],
  );

  if (!open) return null;

  let renderIdx = -1;

  return (
    <div
      className="fixed inset-0 z-[120] flex items-start justify-center bg-black/40 p-4 pt-[12vh] backdrop-blur-[2px]"
      onClick={onClose}
    >
      <div
        className="w-full max-w-xl overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--card)] shadow-2xl"
        onClick={event => event.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-[var(--border)] px-4 py-3">
          <Search size={15} className="shrink-0 text-[var(--muted-foreground)]" />
          <input
            ref={inputRef}
            value={query}
            onChange={event => setQuery(event.target.value)}
            onKeyDown={event => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setActiveIdx(idx => Math.min(idx + 1, filtered.length - 1));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setActiveIdx(idx => Math.max(idx - 1, 0));
              } else if (event.key === "Enter") {
                event.preventDefault();
                execute(filtered[activeIdx]);
              } else if (event.key === "Escape") {
                onClose();
              }
            }}
            placeholder={t("Search sessions and jump to anything…")}
            className="flex-1 bg-transparent text-[14px] text-[var(--foreground)] outline-none placeholder:text-[var(--muted-foreground)]/70"
          />
          <kbd className="rounded border border-[var(--border)] px-1.5 py-0.5 text-[10px] text-[var(--muted-foreground)]">
            {t("Esc")}
          </kbd>
        </div>
        <div ref={listRef} className="max-h-[46vh] overflow-y-auto p-1.5">
          {filtered.length === 0 && (
            <p className="px-3 py-8 text-center text-[13px] text-[var(--muted-foreground)]">
              {t("No matching sessions found.")}
            </p>
          )}
          {(["create", "nav", "session"] as const).map(group => {
            const items = filtered.filter(item => item.group === group);
            if (!items.length) return null;
            const groupLabel =
              group === "create" ? t("Create") : group === "nav" ? t("Go to") : t("Sessions");
            return (
              <div key={group} className="mb-1">
                <p className="px-2.5 pb-1 pt-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-[var(--muted-foreground)]/80">
                  {groupLabel}
                </p>
                {items.map(item => {
                  renderIdx += 1;
                  const idx = renderIdx;
                  const Icon = item.icon;
                  const active = idx === activeIdx;
                  return (
                    <button
                      key={item.id}
                      data-idx={idx}
                      onClick={() => execute(item)}
                      onMouseEnter={() => setActiveIdx(idx)}
                      className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] transition-colors ${
                        active
                          ? "bg-[var(--primary)]/10 text-[var(--foreground)]"
                          : "text-[var(--foreground)]/90 hover:bg-[var(--muted)]/50"
                      }`}
                    >
                      <Icon size={14} className="shrink-0 text-[var(--muted-foreground)]" />
                      <span className="min-w-0 flex-1 truncate">{item.label}</span>
                      {active && (
                        <CornerDownLeft size={12} className="shrink-0 text-[var(--muted-foreground)]" />
                      )}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
        <div className="flex items-center gap-2 border-t border-[var(--border)] px-4 py-1.5 text-[10.5px] text-[var(--muted-foreground)]">
          <span>↑↓</span>
          <span>{t("navigate")}</span>
          <CornerDownLeft size={10} />
          <span>{t("open")}</span>
        </div>
      </div>
    </div>
  );
}

/** Global Ctrl/Cmd+K listener; mount once in the app shell. */
export function useCommandPaletteHotkey(onOpen: () => void) {
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        onOpen();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onOpen]);
}

