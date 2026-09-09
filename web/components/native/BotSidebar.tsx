"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Bell, Bot, Check, ChevronDown, ChevronRight, FolderPlus, MoreHorizontal, Plus, Search, Users } from "lucide-react";
import type { NativeBotProfile, NativeRoom } from "@/lib/knorvia-native-types";
import { errorText, useWorkbench } from "./NativeWorkbenchProvider";
import { useLocalPreference } from "./useLocalPreference";
import { Modal } from "./WorkbenchShell";
import "./bot-sidebar.css";

type Section = { id: string; name: string; entries: string[]; collapsed: boolean };
function sectionsFrom(raw: string): Section[] {
  try {
    const value = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.filter(s => s && typeof s.id === "string" && typeof s.name === "string" && Array.isArray(s.entries)).slice(0, 50).map(s => ({ id: s.id, name: s.name.slice(0, 80), entries: s.entries.filter((v: unknown) => typeof v === "string"), collapsed: s.collapsed === true }));
  } catch { return []; }
}
function timeMs(value?: string) { return value?.endsWith("ms") ? Number(value.slice(0, -2)) : Date.parse(value || ""); }
function age(value: string | undefined, zh: boolean) {
  const ms = timeMs(value); if (!Number.isFinite(ms)) return "";
  const minutes = Math.max(0, Math.floor((Date.now() - ms) / 60000));
  if (minutes < 1) return zh ? "刚刚" : "now";
  if (minutes < 60) return `${minutes}${zh ? "分" : "m"}`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}${zh ? "时" : "h"}`;
  return `${Math.floor(minutes / 1440)}${zh ? "天" : "d"}`;
}
type Entry = { key: string; name: string; bot?: NativeBotProfile; room?: NativeRoom; updatedAt: string };

export function BotSidebar({ navigate }: { navigate: () => void }) {
  const { t, locale, request, connection, setError } = useWorkbench();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [bots, setBots] = useState<NativeBotProfile[]>([]);
  const [rooms, setRooms] = useState<NativeRoom[]>([]);
  const [query, setQuery] = useState("");
  const [attention, setAttention] = useState(false);
  const [sections, updateSections] = useLocalPreference("knorvia-bot-sections-v1", sectionsFrom);
  const [menu, setMenu] = useState<{ key?: string; focusLast?: boolean }>();
  const [filteredSections, setFilteredSections] = useState<Record<string, boolean>>({});
  const [sectionDialog, setSectionDialog] = useState<{ id?: string; name: string }>();
  const [opening, setOpening] = useState<string>();
  const menuRef = useRef<HTMLDivElement>(null);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const menuTrigger = useRef<HTMLButtonElement>(null);
  const plusRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const loaded = useRef(false);
  const closeMenu = useCallback((restoreFocus = false) => {
    setMenu(undefined);
    if (restoreFocus) {
      const trigger = menuTrigger.current;
      (trigger?.isConnected ? trigger : plusRef.current)?.focus({ preventScroll: true });
    }
  }, []);
  const openMenu = (trigger: HTMLButtonElement, key?: string, focusLast = false) => {
    if (menu && menuTrigger.current === trigger && !focusLast) { closeMenu(true); return; }
    menuTrigger.current = trigger;
    setMenu({ key, focusLast });
  };
  useEffect(() => { setFilteredSections({}); }, [query, attention]);
  const refresh = useCallback(async () => {
    const [b, r] = await Promise.all([request<NativeBotProfile[]>("bot/list", {}), request<NativeRoom[]>("room/list", {})]);
    setBots(b); setRooms(r); loaded.current = true;
  }, [request]);
  useEffect(() => {
    if (connection !== "connected") return;
    let disposed = false; let busy = false;
    const load = async () => {
      if (busy || disposed || document.hidden) return;
      busy = true;
      try { await refresh(); } catch (e) { if (!disposed && !loaded.current) setError(errorText(e)); }
      finally { busy = false; }
    };
    void load();
    const interval = setInterval(load, 2500);
    window.addEventListener("knorvia-bots-changed", load);
    document.addEventListener("visibilitychange", load);
    return () => { disposed = true; clearInterval(interval); window.removeEventListener("knorvia-bots-changed", load); document.removeEventListener("visibilitychange", load); };
  }, [connection, refresh, setError]);
  useLayoutEffect(() => {
    if (!menu) return;
    const element = menuRef.current;
    const host = sidebarRef.current;
    if (!element || !host) return;
    const position = () => {
      const trigger = menuTrigger.current;
      if (!trigger?.isConnected) { closeMenu(); return; }
      const anchor = trigger.getBoundingClientRect();
      const bounds = host.getBoundingClientRect();
      const bottom = Math.min(bounds.bottom, window.innerHeight);
      if (anchor.bottom < bounds.top || anchor.top > bottom) { closeMenu(); return; }
      element.style.maxHeight = `${Math.max(80, Math.min(480, bottom - bounds.top - 16))}px`;
      const height = element.getBoundingClientRect().height;
      const preferred = anchor.bottom + 6 + height <= bottom - 8 ? anchor.bottom + 6 : anchor.top - height - 6;
      element.style.top = `${Math.max(8, Math.min(preferred - bounds.top, bottom - bounds.top - height - 8))}px`;
    };
    position();
    const buttons = element.querySelectorAll<HTMLButtonElement>("button:not(:disabled)");
    (menu.focusLast ? buttons[buttons.length - 1] : buttons[0])?.focus({ preventScroll: true });
    const observer = new ResizeObserver(position);
    observer.observe(host); observer.observe(element);
    const scroll = (event: Event) => { if (!element.contains(event.target as Node)) position(); };
    window.addEventListener("resize", position); document.addEventListener("scroll", scroll, true);
    return () => { observer.disconnect(); window.removeEventListener("resize", position); document.removeEventListener("scroll", scroll, true); };
  }, [menu, closeMenu]);
  useEffect(() => {
    if (!menu) return;
    let search = ""; let lastTyped = 0;
    const close = (e: PointerEvent) => { if (!menuRef.current?.contains(e.target as Node) && !menuTrigger.current?.contains(e.target as Node)) closeMenu(); };
    const key = (e: KeyboardEvent) => {
      if (!menuRef.current?.contains(document.activeElement) || e.isComposing) return;
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeMenu(true); return; }
      const buttons = Array.from(menuRef.current.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
      const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
      if (e.key === "Tab") {
        e.preventDefault();
        const focusable = Array.from(document.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]'))
          .filter(item => !menuRef.current?.contains(item) && !item.closest('[inert]') && item.getClientRects().length > 0);
        const index = focusable.indexOf(menuTrigger.current!);
        const next = focusable[index + (e.shiftKey ? -1 : 1)];
        closeMenu(!next); next?.focus({ preventScroll: true }); return;
      }
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
        const next = e.key === "Home" ? 0 : e.key === "End" ? buttons.length - 1 : (current + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
        e.preventDefault(); buttons[next]?.focus(); return;
      }
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && e.key !== " ") {
        const now = Date.now(); search = now - lastTyped < 700 ? search + e.key.toLocaleLowerCase() : e.key.toLocaleLowerCase(); lastTyped = now;
        const ordered = [...buttons.slice(current + 1), ...buttons.slice(0, current + 1)];
        ordered.find(button => button.textContent?.trim().toLocaleLowerCase().startsWith(search))?.focus(); e.preventDefault();
      }
    };
    document.addEventListener("pointerdown", close); document.addEventListener("keydown", key, true);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", key, true); };
  }, [menu, closeMenu]);
  const allEntries = useMemo<Entry[]>(() => [
    ...bots.map(bot => {
      const room = rooms.find(r => r.kind === "dm" && r.members.some(m => m.botId === bot.id));
      return { key: `bot:${bot.id}`, name: bot.name, bot, room, updatedAt: room?.lastMessage?.createdAt ?? bot.updatedAt };
    }),
    ...rooms.filter(r => r.kind === "group").map(room => ({ key: `room:${room.id}`, name: room.title, room, updatedAt: room.lastMessage?.createdAt ?? room.updatedAt })),
  ].sort((a, b) => (timeMs(b.updatedAt) || 0) - (timeMs(a.updatedAt) || 0)), [bots, rooms]);
  const entries = allEntries.filter(e => e.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()) && (!attention || !!e.room?.pendingAttention || !!e.room?.unreadCount));
  const filtering = !!query.trim() || attention;
  const assigned = new Set(sections.flatMap(s => s.entries));
  const totalAttention = rooms.reduce((n, r) => n + (r.pendingAttention || 0) + (r.unreadCount || 0), 0);
  const menuEntry = allEntries.find(e => e.key === menu?.key);
  const go = (url: string) => { setMenu(undefined); router.push(url); navigate(); };
  const open = async (entry: Entry) => {
    if (opening) return;
    setOpening(entry.key);
    try {
      const room = entry.room ?? await request<NativeRoom>("room/ensureDm", { botId: entry.bot!.id });
      go(`/workbench/bots?room=${encodeURIComponent(room.id)}`);
      void refresh();
    } catch (e) { setError(errorText(e)); } finally { setOpening(undefined); }
  };
  const move = (key: string, id?: string) => {
    updateSections(current => current.map(s => ({ ...s, entries: [...s.entries.filter(v => v !== key), ...(s.id === id ? [key] : [])] })));
    closeMenu(true);
  };
  const row = (entry: Entry) => {
    const selected = (!!entry.room && searchParams.get("room") === entry.room.id) || (!!entry.bot && searchParams.get("bot") === entry.bot.id);
    const hue = [...entry.key].reduce((n, c) => (n * 31 + c.charCodeAt(0)) % 360, 0);
    return <div key={entry.key} className={`nw-bot-row ${selected ? "is-active" : ""}`}>
      <button className="nw-bot-open" onClick={() => void open(entry)} aria-current={selected ? "page" : undefined} disabled={opening === entry.key}>
        <span className="nw-bot-avatar" style={{ "--bot-hue": hue } as CSSProperties}>{entry.bot ? <Bot size={21} /> : <Users size={21} />}</span>
        <span className="nw-bot-copy"><span className="nw-bot-title"><strong>{entry.name}</strong><time dateTime={Number.isFinite(timeMs(entry.updatedAt)) ? new Date(timeMs(entry.updatedAt)).toISOString() : undefined}>{age(entry.updatedAt, locale === "zh")}</time></span>
          <span className="nw-bot-excerpt">{entry.room?.pendingAttention ? t("等待你处理 · ", "Needs attention · ") : ""}{entry.room?.lastMessage?.content || t(entry.bot ? "开始一段对话" : "还没有消息", entry.bot ? "Start a conversation" : "No messages yet")}</span>
        </span>{!!entry.room?.unreadCount && <span className="nw-bot-count">{entry.room.unreadCount > 99 ? "99+" : entry.room.unreadCount}</span>}
      </button>
      <button className="nw-icon nw-bot-more" aria-label={`${t("更多操作", "More actions")} · ${entry.name}`} aria-haspopup="menu" aria-controls={menu?.key === entry.key ? menuId : undefined} aria-expanded={menu?.key === entry.key} onClick={event => openMenu(event.currentTarget, entry.key)} onKeyDown={event => { if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); openMenu(event.currentTarget, entry.key, event.key === "ArrowUp"); } }}><MoreHorizontal size={15} /></button>
    </div>;
  };
  return <div ref={sidebarRef} className="nw-bot-sidebar">
    <div className="nw-bot-toolbar"><span>BOTS</span><div><button className={`nw-icon ${attention ? "is-active" : ""}`} aria-label={t("未读与待处理", "Unread and attention")} aria-pressed={attention} onClick={() => setAttention(v => !v)}><Bell size={18} />{totalAttention > 0 && <i />}</button><button ref={plusRef} className="nw-icon" aria-label={t("新建机器人、群聊或分区", "New bot, group or section")} aria-haspopup="menu" aria-controls={menu && !menu.key ? menuId : undefined} aria-expanded={!!menu && !menu.key} onClick={event => openMenu(event.currentTarget)} onKeyDown={event => { if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); openMenu(event.currentTarget, undefined, event.key === "ArrowUp"); } }}><Plus size={20} /></button></div></div>
    <label className="nw-bot-search"><Search size={14} /><input value={query} onChange={e => setQuery(e.target.value)} placeholder={t("搜索 Bots", "Search Bots")} aria-label={t("搜索 Bots", "Search Bots")} /></label>
    {menu && <div ref={menuRef} id={menuId} className="nw-bot-menu" role="menu" aria-label={t("Bot 操作", "Bot actions")}>
      {!menu.key ? <><button role="menuitem" onClick={() => go("/workbench/bots?create=bot")}><Bot size={17} />{t("新建机器人", "New bot")}</button><button role="menuitem" disabled={!bots.length} onClick={() => go("/workbench/bots?create=group")}><Users size={17} />{t("新建群聊", "New group")}</button><hr /><button role="menuitem" onClick={() => { setMenu(undefined); setSectionDialog({ name: "" }); }}><FolderPlus size={17} />{t("新建分区", "New section")}</button></> : <>
        {menuEntry?.bot && <button role="menuitem" onClick={() => go(`/workbench/bots?bot=${encodeURIComponent(menuEntry.bot!.id)}`)}><Bot size={17} />{t("机器人设置与 Soul", "Bot settings & Soul")}</button>}
        <span>{t("移到分区", "Move to section")}</span><button role="menuitem" onClick={() => move(menu.key!)}>{t("未分区", "Unsectioned")}</button>{sections.map(s => <button key={s.id} role="menuitem" onClick={() => move(menu.key!, s.id)}>{s.name}{s.entries.includes(menu.key!) && <Check size={13} />}</button>)}
      </>}
    </div>}
    <div className="nw-bot-list">
      {entries.filter(e => !assigned.has(e.key)).map(row)}
      {sections.map(section => {
        const matches = entries.filter(entry => section.entries.includes(entry.key));
        if (filtering && matches.length === 0) return null;
        const expanded = filtering ? filteredSections[section.id] !== false : !section.collapsed;
        return <section key={section.id} className="nw-bot-section"><div><button aria-expanded={expanded} onClick={() => filtering ? setFilteredSections(current => ({ ...current, [section.id]: !expanded })) : updateSections(current => current.map(s => s.id === section.id ? { ...s, collapsed: !s.collapsed } : s))}>{expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}{section.name}</button><button className="nw-icon" aria-label={`${t("编辑分区", "Edit section")} · ${section.name}`} onClick={() => setSectionDialog({ id: section.id, name: section.name })}><MoreHorizontal size={14} /></button></div>{expanded && matches.map(row)}</section>;
      })}
      {entries.length === 0 && <p className="nw-bot-empty">{t(attention ? "目前没有未读或待处理消息" : "还没有匹配的 Bot", attention ? "No unread or pending messages" : "No matching bots")}</p>}
    </div>
    {sectionDialog && <Modal title={t(sectionDialog.id ? "编辑分区" : "新建分区", sectionDialog.id ? "Edit section" : "New section")} close={() => setSectionDialog(undefined)}><form onSubmit={e => { e.preventDefault(); const name = sectionDialog.name.trim(); if (!name) return; updateSections(current => sectionDialog.id ? current.map(s => s.id === sectionDialog.id ? { ...s, name } : s) : [...current, { id: crypto.randomUUID(), name, entries: [], collapsed: false }]); setSectionDialog(undefined); }}><label className="nw-field">{t("分区名称", "Section name")}<input autoFocus required maxLength={80} value={sectionDialog.name} onChange={e => setSectionDialog({ ...sectionDialog, name: e.target.value })} /></label><div className="nw-dialog-actions">{sectionDialog.id && <button type="button" className="nw-button" onClick={() => { updateSections(current => current.filter(s => s.id !== sectionDialog.id)); setSectionDialog(undefined); }}>{t("移除分区", "Remove section")}</button>}<button className="nw-button nw-button-primary" disabled={!sectionDialog.name.trim()}>{t("保存", "Save")}</button></div></form></Modal>}
  </div>;
}
