"use client";

/**
 * Group chat rooms v2 — rooms start empty; the user seats CLI-backed
 * members (claude/codex/grok/... or a partner), gives each a room-local
 * display name and identity word, and chats. Every member's CLI session
 * is anchored to this room: reopening resumes exactly that history.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, Send, Trash2, Users, X } from "lucide-react";
import { apiFetch, apiUrl } from "@/lib/api";
import { listSubagentConnections } from "@/lib/subagents-api";

interface RoomMemberInfo {
  backend: string;
  connection: string;
  display_name: string;
  persona: string;
}

interface RoomSummary {
  id: string;
  name: string;
  members: RoomMemberInfo[];
  message_count: number;
  last_message: string;
  last_timestamp: number;
  needs_you?: boolean;
}

interface RoomTranscriptMessage {
  sender: string;
  sender_name: string;
  content: string;
  timestamp?: number;
}

const BACKEND_OPTIONS = [
  { value: "claude_code", label: "Claude Code" },
  { value: "codex", label: "Codex CLI" },
  { value: "gemini", label: "Gemini CLI" },
  { value: "grok_build", label: "Grok Build" },
  { value: "kimi", label: "Kimi CLI" },
  { value: "opencode", label: "opencode" },
  { value: "mimo", label: "MiMo Code" },
  { value: "partner", label: "Partner" },
];

export default function GroupRooms() {
  const { t } = useTranslation();
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [connections, setConnections] = useState<
    { name: string; agent_kind?: string }[]
  >([]);
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);

  const [activeId, setActiveId] = useState<string | null>(null);
  const [members, setMembers] = useState<RoomMemberInfo[]>([]);
  const [transcript, setTranscript] = useState<RoomTranscriptMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [speaking, setSpeaking] = useState(false);
  const [mentionOpen, setMentionOpen] = useState(false);

  // add-member form state
  const [showAdd, setShowAdd] = useState(false);
  const [addBackend, setAddBackend] = useState("claude_code");
  const [addConnection, setAddConnection] = useState("");
  const [addDisplay, setAddDisplay] = useState("");
  const [addPersona, setAddPersona] = useState("");

  const bottomRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    try {
      const data = (await apiFetch(apiUrl("/api/v1/partners/groups"), {
        cache: "no-store",
      })) as unknown as { rooms: RoomSummary[] };
      setRooms(data.rooms ?? []);
    } catch {
      /* best effort */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    listSubagentConnections()
      .then((conns: unknown) =>
        setConnections(
          (Array.isArray(conns) ? conns : []) as {
            name: string;
            agent_kind?: string;
          }[],
        ),
      )
      .catch(() => {});
  }, [refresh]);

  useEffect(() => {
    if (!activeId) return;
    apiFetch(apiUrl(`/api/v1/partners/groups/${encodeURIComponent(activeId)}`), {
      cache: "no-store",
    })
      .then(response =>
        (
          response.json() as Promise<{
            room: { members: RoomMemberInfo[]; messages: RoomTranscriptMessage[] };
          }>
        ).then(data => {
          setMembers(data.room?.members ?? []);
          setTranscript(data.room?.messages ?? []);
        }),
      )
      .catch(() => {});
  }, [activeId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [transcript]);

  const create = async () => {
    if (!newName.trim() || creating) return;
    setCreating(true);
    try {
      const data = (await apiFetch(apiUrl("/api/v1/partners/groups"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName.trim() }),
      })) as unknown as { room: { id: string } };
      setNewName("");
      await refresh();
      setActiveId(data.room.id);
      setShowAdd(true);
    } finally {
      setCreating(false);
    }
  };

  const addMember = async () => {
    if (!activeId || !addConnection.trim()) return;
    try {
      await apiFetch(
        apiUrl(`/api/v1/partners/groups/${encodeURIComponent(activeId)}/members`),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            backend: addBackend,
            connection: addConnection.trim(),
            display_name: addDisplay.trim(),
            persona: addPersona.trim(),
          }),
        },
      );
      setAddConnection("");
      setAddDisplay("");
      setAddPersona("");
      setShowAdd(false);
      // Reload the open room.
      const data = (await apiFetch(
        apiUrl(`/api/v1/partners/groups/${encodeURIComponent(activeId)}`),
        { cache: "no-store" },
      )) as unknown as { room: { members: RoomMemberInfo[] } };
      setMembers(data.room?.members ?? []);
      void refresh();
    } catch {
      /* surfaced by global handler */
    }
  };

  const updateMember = async (connection: string, persona: string) => {
    if (!activeId) return;
    await apiFetch(
      apiUrl(`/api/v1/partners/groups/${encodeURIComponent(activeId)}/member`),
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connection, persona }),
      },
    ).catch(() => {});
    setMembers(prev =>
      prev.map(m => (m.connection === connection ? { ...m, persona } : m)),
    );
  };

  const removeMember = async (connection: string) => {
    if (!activeId) return;
    await apiFetch(
      apiUrl(
        `/api/v1/partners/groups/${encodeURIComponent(activeId)}/members/${encodeURIComponent(connection)}`,
      ),
      { method: "DELETE" },
    ).catch(() => {});
    setMembers(prev => prev.filter(m => m.connection !== connection));
    void refresh();
  };

  const say = async () => {
    const text = draft.trim();
    if (!text || !activeId || speaking) return;
    setSpeaking(true);
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

  const activeRoom = rooms.find(room => room.id === activeId) ?? null;

  const onDraftChange = (value: string) => {
    setDraft(value);
    setMentionOpen(value[value.length - 1] === "@");
  };

  const insertMention = (name: string) => {
    setDraft(prev => (prev.endsWith("@") ? `${prev}${name} ` : `${prev}@${name} `));
    setMentionOpen(false);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      {/* Create room (empty at birth) */}
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
            className="w-56 rounded-lg border border-[var(--border)] bg-[var(--background)] px-2.5 py-1.5 text-[12.5px] outline-none focus:border-[var(--primary)]/50"
          />
          <button
            type="button"
            onClick={() => void create()}
            disabled={!newName.trim() || creating}
            className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--primary)] px-3 py-1.5 text-[12.5px] font-medium text-[var(--primary-foreground)] disabled:opacity-40"
          >
            {creating ? <Loader2 size={13} className="animate-spin" /> : null}
            {t("Create empty room")}
          </button>
          <span className="text-[11px] text-[var(--muted-foreground)]">
            {t("Then seat CLI-backed members inside — each keeps its own anchored session.")}
          </span>
        </div>
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
                <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-[var(--muted-foreground)]">
                  {room.needs_you ? (
                    <span className="rounded-full bg-[var(--primary)]/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--primary)]">
                      {t("Needs you")}
                    </span>
                  ) : null}
                  {room.members.length} {t("members")}
                </span>
              </div>
              <p className="mt-0.5 line-clamp-1 text-[11.5px] text-[var(--muted-foreground)]">
                {room.last_message || t("No messages yet")}
              </p>
            </div>
          ))}
        </div>
      )}

      {/* Active room */}
      {activeId && activeRoom && (
        <div className="flex min-h-[360px] flex-col rounded-2xl border border-[var(--border)] bg-[var(--card)]/60">
          <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-2">
            <span className="flex items-center gap-2 text-[13px] font-semibold text-[var(--foreground)]">
              {activeRoom.name}
              {activeRoom.needs_you ? (
                <span className="rounded-full bg-[var(--primary)]/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--primary)]">
                  {t("Needs you")}
                </span>
              ) : null}
            </span>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setShowAdd(prev => !prev)}
                className="rounded-md border border-[var(--border)] px-2 py-0.5 text-[11px] text-[var(--foreground)]"
              >
                + {t("Add member")}
              </button>
              <button
                type="button"
                onClick={() => {
                  setActiveId(null);
                  setMembers([]);
                  setTranscript([]);
                }}
                className="rounded-md p-1 text-[var(--muted-foreground)] hover:bg-[var(--muted)]/55 hover:text-[var(--foreground)]"
              >
                <X size={14} />
              </button>
            </div>
          </div>

          {/* Members strip with room-local rename + persona */}
          <div className="flex flex-wrap items-center gap-2 border-b border-[var(--border)] px-4 py-2">
            {members.length === 0 && (
              <span className="text-[11.5px] text-[var(--muted-foreground)]">
                {t("Empty room — add a member to start talking.")}
              </span>
            )}
            {members.map(member => (
              <div
                key={member.connection}
                className="flex items-center gap-1.5 rounded-full bg-[var(--muted)]/50 py-1 pl-2.5 pr-1.5"
              >
                <span className="text-[11.5px] font-medium text-[var(--foreground)]">
                  {member.display_name || member.connection}
                </span>
                <span className="rounded-full bg-[var(--background)] px-1.5 text-[10px] text-[var(--muted-foreground)]">
                  {BACKEND_OPTIONS.find(b => b.value === member.backend)?.label ??
                    member.backend}
                </span>
                <input
                  defaultValue={member.persona}
                  placeholder={t("identity word")}
                  onBlur={event => {
                    if (event.target.value !== member.persona)
                      void updateMember(member.connection, event.target.value);
                  }}
                  className="w-24 rounded-full border border-transparent bg-transparent px-1.5 text-[10.5px] text-[var(--muted-foreground)] outline-none focus:border-[var(--primary)]/40 focus:text-[var(--foreground)]"
                />
                <button
                  type="button"
                  onClick={() => void removeMember(member.connection)}
                  className="rounded-full p-0.5 text-[var(--muted-foreground)] hover:text-[var(--destructive)]"
                >
                  <Trash2 size={11} />
                </button>
              </div>
            ))}
          </div>

          {/* Add-member form */}
          {showAdd && (
            <div className="flex flex-wrap items-end gap-2 border-b border-[var(--border)] bg-[var(--muted)]/25 px-4 py-3">
              <label className="flex flex-col gap-1 text-[10.5px] uppercase tracking-wide text-[var(--muted-foreground)]">
                {t("Backend")}
                <select
                  value={addBackend}
                  onChange={event => setAddBackend(event.target.value)}
                  className="rounded-lg border border-[var(--border)] bg-[var(--background)] px-2 py-1.5 text-[12px] outline-none"
                >
                  {BACKEND_OPTIONS.map(option => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-[10.5px] uppercase tracking-wide text-[var(--muted-foreground)]">
                {t("Connection")}
                <input
                  value={addConnection}
                  onChange={event => setAddConnection(event.target.value)}
                  placeholder={
                    connections[0]?.name ?? t("connected agent name")
                  }
                  list="grp-conn-list"
                  className="w-36 rounded-lg border border-[var(--border)] bg-[var(--background)] px-2 py-1.5 text-[12px] outline-none"
                />
                <datalist id="grp-conn-list">
                  {connections.map(connection => (
                    <option key={connection.name} value={connection.name} />
                  ))}
                </datalist>
              </label>
              <label className="flex flex-col gap-1 text-[10.5px] uppercase tracking-wide text-[var(--muted-foreground)]">
                {t("Display name")}
                <input
                  value={addDisplay}
                  onChange={event => setAddDisplay(event.target.value)}
                  placeholder={t("e.g. Researcher")}
                  className="w-28 rounded-lg border border-[var(--border)] bg-[var(--background)] px-2 py-1.5 text-[12px] outline-none"
                />
              </label>
              <label className="flex flex-col gap-1 text-[10.5px] uppercase tracking-wide text-[var(--muted-foreground)]">
                {t("Identity word")}
                <input
                  value={addPersona}
                  onChange={event => setAddPersona(event.target.value)}
                  placeholder={t("e.g. rigorous, concise")}
                  className="w-32 rounded-lg border border-[var(--border)] bg-[var(--background)] px-2 py-1.5 text-[12px] outline-none"
                />
              </label>
              <button
                type="button"
                onClick={() => void addMember()}
                disabled={!addConnection.trim()}
                className="rounded-lg bg-[var(--primary)] px-3 py-1.5 text-[12px] font-medium text-[var(--primary-foreground)] disabled:opacity-40"
              >
                {t("Seat member")}
              </button>
            </div>
          )}

          {/* Transcript */}
          <div className="max-h-[42vh] min-h-0 flex-1 overflow-y-auto px-4 py-3">
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
                {t("The members are thinking…")}
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          {/* Composer */}
          {mentionOpen &&
            members.map(member => ({
              name: member.display_name || member.connection,
              id: member.connection,
            })).length > 0 && (
              <div className="flex flex-wrap gap-1 border-t border-[var(--border)] px-3 pb-2 pt-2">
                {members.map(member => (
                  <button
                    key={member.connection}
                    type="button"
                    onClick={() =>
                      insertMention(member.display_name || member.connection)
                    }
                    className="rounded-full border border-[var(--border)] px-2.5 py-1 text-[11.5px] text-[var(--muted-foreground)] transition-colors hover:border-[var(--primary)]/50 hover:text-[var(--foreground)]"
                  >
                    @{member.display_name || member.connection}
                  </button>
                ))}
              </div>
            )}
          <div className="flex items-center gap-2 p-2">
            <input
              value={draft}
              onChange={event => onDraftChange(event.target.value)}
              onKeyDown={event => {
                if (event.key === "Enter") void say();
              }}
              placeholder={
                members.length === 0
                  ? t("Add a member first")
                  : t("Say something — @name a bot, or wait; they may @user you")
              }
              disabled={members.length === 0}
              className="flex-1 rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-[12.5px] outline-none focus:border-[var(--primary)]/50 disabled:opacity-50"
            />
            <button
              type="button"
              onClick={() => void say()}
              disabled={speaking || !draft.trim() || members.length === 0}
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
