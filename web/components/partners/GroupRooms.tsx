"use client";

/**
 * Group chat rooms UI — roster row type + chat surface for 2-6 partners
 * coordinating in one shared space (Hermes bot-mode group parity).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, Send, Users, X } from "lucide-react";
import { apiFetch, apiUrl } from "@/lib/api";
import { listPartners, type PartnerInfo } from "@/lib/partners-api";

interface RoomSummary {
  id: string;
  name: string;
  members: string[];
  member_names: Record<string, string>;
  message_count: number;
  last_message: string;
  last_timestamp: number;
}

interface RoomTranscriptMessage {
  sender: string;
  sender_name: string;
  content: string;
  timestamp?: number;
}

export default function GroupRooms() {
  const { t } = useTranslation();
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [partners, setPartners] = useState<PartnerInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<RoomTranscriptMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [speaking, setSpeaking] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    try {
      const data = (await apiFetch(
        apiUrl("/api/v1/partners/groups"),
        { cache: "no-store" },
      )) as unknown as { rooms: RoomSummary[] };
      setRooms(data.rooms ?? []);
    } catch {
      /* roster refresh is best-effort */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    listPartners()
      .then(setPartners)
      .catch(() => {});
  }, [refresh]);

  useEffect(() => {
    if (!activeId) return;
    apiFetch(apiUrl(`/api/v1/partners/groups/${encodeURIComponent(activeId)}`), {
      cache: "no-store",
    })
      .then(response =>
        (response.json() as Promise<{ room: { messages: RoomTranscriptMessage[] } }>).then(
          data => setTranscript(data.room?.messages ?? []),
        ),
      )
      .catch(() => {});
  }, [activeId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [transcript]);

  const toggleMember = (pid: string) => {
    setSelected(prev =>
      prev.includes(pid)
        ? prev.filter(id => id !== pid)
        : prev.length >= 6
          ? prev
          : [...prev, pid],
    );
  };

  const create = async () => {
    if (!newName.trim() || selected.length < 2 || creating) return;
    setCreating(true);
    try {
      const data = (await apiFetch(apiUrl("/api/v1/partners/groups"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName.trim(), members: selected }),
      })) as unknown as { room: { id: string } };
      setNewName("");
      setSelected([]);
      await refresh();
      setActiveId(data.room.id);
    } finally {
      setCreating(false);
    }
  };

  const say = async () => {
    const text = draft.trim();
    if (!text || !activeId || speaking) return;
    setSpeaking(true);
    // Optimistically show the user's own line.
    setTranscript(prev => [
      ...prev,
      { sender: "user", sender_name: "user", content: text },
    ]);
    setDraft("");
    try {
      const data = (await apiFetch(
        apiUrl(`/api/v1/partners/groups/${encodeURIComponent(activeId)}/say`),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: text }),
        },
      )) as unknown as { transcript: RoomTranscriptMessage[] };
      setTranscript(data.transcript ?? []);
      void refresh();
    } catch {
      void refresh();
    } finally {
      setSpeaking(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      {/* Create room */}
      <div className="rounded-2xl border border-[var(--border)] bg-[var(--card)]/60 p-4">
        <div className="mb-2 flex items-center gap-2 text-[13px] font-semibold text-[var(--foreground)]">
          <Users size={15} className="text-[var(--primary)]" />
          {t("New group room")}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={newName}
            onChange={event => setNewName(event.target.value)}
            placeholder={t("Group name")}
            maxLength={80}
            className="w-48 rounded-lg border border-[var(--border)] bg-[var(--background)] px-2.5 py-1.5 text-[12.5px] outline-none focus:border-[var(--primary)]/50"
          />
          <div className="flex flex-wrap items-center gap-1">
            {partners.slice(0, 12).map(partner => (
              <button
                key={partner.partner_id}
                type="button"
                onClick={() => toggleMember(partner.partner_id)}
                className={`rounded-full border px-2.5 py-1 text-[11.5px] transition-colors ${
                  selected.includes(partner.partner_id)
                    ? "border-[var(--primary)]/60 bg-[var(--primary)]/10 text-[var(--foreground)]"
                    : "border-[var(--border)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                }`}
              >
                {partner.name || partner.partner_id}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => void create()}
            disabled={!newName.trim() || selected.length < 2 || creating}
            className="ml-auto inline-flex items-center gap-1.5 rounded-lg bg-[var(--primary)] px-3 py-1.5 text-[12.5px] font-medium text-[var(--primary-foreground)] disabled:opacity-40"
          >
            {creating ? <Loader2 size={13} className="animate-spin" /> : null}
            {t("Create room")}
          </button>
        </div>
        <p className="mt-1.5 text-[11px] text-[var(--muted-foreground)]">
          {t("Pick 2 to 6 partners; they take turns answering in the room.")}
        </p>
      </div>

      {/* Rooms */}
      {loading ? (
        <p className="text-[12px] text-[var(--muted-foreground)]">{t("Loading…")}</p>
      ) : rooms.length === 0 ? (
        <p className="rounded-xl border border-dashed border-[var(--border)] px-4 py-8 text-center text-[12.5px] text-[var(--muted-foreground)]">
          {t("No group rooms yet.")}
        </p>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {rooms.map(room => (
            <div
              key={room.id}
              className={`cursor-pointer rounded-2xl border bg-[var(--card)]/60 p-3 transition-colors hover:border-[var(--ring)] ${
                activeId === room.id ? "border-[var(--ring)]" : "border-[var(--border)]"
              }`}
              onClick={() => setActiveId(room.id)}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-[13px] font-semibold text-[var(--foreground)]">
                  {room.name}
                </span>
                <span className="shrink-0 text-[11px] text-[var(--muted-foreground)]">
                  {room.members.length} {t("members")}
                </span>
              </div>
              <p className="mt-0.5 line-clamp-1 text-[11.5px] text-[var(--muted-foreground)]">
                {room.last_message || t("No messages yet")}
              </p>
              {activeId === room.id && (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {room.members.map(pid => (
                    <span
                      key={pid}
                      className="rounded-full bg-[var(--muted)] px-2 py-0.5 text-[10.5px] text-[var(--muted-foreground)]"
                    >
                      {room.member_names[pid] || pid}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Active room chat */}
      {activeId && (
        <div className="flex min-h-[320px] flex-col rounded-2xl border border-[var(--border)] bg-[var(--card)]/60">
          <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-2">
            <span className="text-[13px] font-semibold text-[var(--foreground)]">
              {rooms.find(room => room.id === activeId)?.name ?? activeId}
            </span>
            <button
              type="button"
              onClick={() => {
                setActiveId(null);
                setTranscript([]);
              }}
              className="rounded-md p-1 text-[var(--muted-foreground)] hover:bg-[var(--muted)]/55 hover:text-[var(--foreground)]"
            >
              <X size={14} />
            </button>
          </div>
          <div className="max-h-[46vh] min-h-0 flex-1 overflow-y-auto px-4 py-3">
            {transcript.map((message, index) => (
              <div
                key={`${message.sender}-${index}`}
                className={`mb-2 ${message.sender === "user" ? "text-right" : ""}`}
              >
                <span className="mr-1.5 text-[10.5px] font-medium uppercase tracking-wide text-[var(--muted-foreground)]">
                  {message.sender === "user" ? t("You") : message.sender_name || message.sender}
                </span>
                <span
                  className={`inline-block max-w-[85%] whitespace-pre-wrap break-words rounded-xl px-3 py-1.5 text-left text-[12.5px] leading-relaxed ${
                    message.sender === "user"
                      ? "bg-[var(--primary)]/10 text-[var(--foreground)]"
                      : "bg-[var(--muted)]/50 text-[var(--foreground)]/90"
                  }`}
                >
                  {message.content}
                </span>
              </div>
            ))}
            {speaking && (
              <div className="flex items-center gap-1.5 text-[11.5px] text-[var(--muted-foreground)]">
                <Loader2 size={12} className="animate-spin" />
                {t("The partners are thinking…")}
              </div>
            )}
            <div ref={bottomRef} />
          </div>
          <div className="flex items-center gap-2 border-t border-[var(--border)] p-2">
            <input
              value={draft}
              onChange={event => setDraft(event.target.value)}
              onKeyDown={event => {
                if (event.key === "Enter") void say();
              }}
              placeholder={t("Say something to the whole room…")}
              className="flex-1 rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-[12.5px] outline-none focus:border-[var(--primary)]/50"
            />
            <button
              type="button"
              onClick={() => void say()}
              disabled={speaking || !draft.trim()}
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--primary)] text-[var(--primary-foreground)] disabled:opacity-40"
            >
              <Send size={15} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
