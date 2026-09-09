"use client";

// Bots & groups: the workbench surface for the social domain. Everything
// shown here comes from durable daemon facts (bot profiles, rooms, bindings,
// transcripts); nothing is mocked. CLI backend rows reflect real local
// detection — an uninstalled backend is displayed as unavailable, never
// pretend-enabled.

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, ArrowUp, Bot, Check, Copy, FileText, Loader2, MessageSquare, Pencil, Plus, RefreshCw, Square, Users, X } from "lucide-react";
import { Markdown } from "./TaskTimeline";
import { errorText, useWorkbench } from "./NativeWorkbenchProvider";
import { Modal } from "./WorkbenchShell";
import type {
  NativeBotProfile,
  NativeCliBackendStatus,
  NativeResolvedBinding,
  NativeRoom,
  NativeRoomMessage,
  NativeSessionBinding,
} from "@/lib/knorvia-native-types";
import "./bots.css";
import "./bot-conversation.css";

// Store timestamps are epoch millis with an "ms" suffix (see
// knorvia-rs store now_rfc3339); parse that shape explicitly instead of
// relying on Date to accept it.
function storeTime(value: string): string {
  const match = /^(\d+)ms$/.exec(value);
  const millis = match ? Number(match[1]) : Date.parse(value);
  if (!Number.isFinite(millis)) return "";
  return new Date(millis).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

type Selected =
  | { kind: "bot"; botId: string }
  | { kind: "room"; conversationId: string };

function BackendBadge({ backend }: { backend: NativeCliBackendStatus | undefined }) {
  const { t } = useWorkbench();
  if (!backend) return null;
  const label = !backend.installed
    ? t("未安装", "Not installed")
    : backend.authState === "connected"
      ? t("已登录", "Signed in")
      : backend.authState === "needs-user"
        ? t("待登录", "Sign-in needed")
        : t("登录状态未知", "Sign-in unknown");
  return (
    <span className={`bots-backend-badge ${backend.installed ? "" : "is-off"}`}>
      {backend.label} · {backend.installed ? backend.version ?? "?" : label}
      {!backend.installed ? "" : ` · ${label}`}
    </span>
  );
}

function BotEditor({ bot, close, saved, backends = [] }: { bot?: NativeBotProfile; close: () => void; saved: () => Promise<void>; backends?: NativeCliBackendStatus[] }) {
  const { t, request } = useWorkbench();
  const [name, setName] = useState(bot?.name ?? "");
  const [soul, setSoul] = useState(bot?.soul ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [backendId, setBackendId] = useState("kernel");
  return (
    <Modal title={bot ? t("编辑 Bot", "Edit bot") : t("新建 Bot", "New bot")} close={close} busy={pending}>
      <form
        onSubmit={async event => {
          event.preventDefault();
          if (pending) return;
          setPending(true);
          setError("");
          try {
            if (bot) {
              let revision = bot.revision;
              if (name.trim() && name.trim() !== bot.name) {
                const renamed = await request<NativeBotProfile>("bot/rename", { botId: bot.id, name: name.trim(), expectedRevision: revision });
                revision = renamed.revision;
              }
              if (soul.trim() && soul.trim() !== bot.soul) {
                await request("bot/updateSoul", { botId: bot.id, soul: soul.trim(), expectedRevision: revision });
              }
            } else {
              await request("bot/create", { name: name.trim(), soul: soul.trim(), backendKind: backendId === "kernel" ? "kernel" : "cli", backendBindingId: backendId });
            }
            await saved();
            close();
          } catch (caught) {
            setError(errorText(caught));
          } finally {
            setPending(false);
          }
        }}
      >
        <label className="nw-field">
          {t("名称", "Name")}
          <input
            autoFocus
            required
            maxLength={80}
            value={name}
            onChange={event => setName(event.target.value)}
            placeholder={t("例如：研究助手", "e.g. Research assistant")}
          />
        </label>
        <label className="nw-field">
          {t("Soul（性格与边界）", "Soul (persona & boundaries)")}
          <textarea
            required={!bot}
            rows={6}
            maxLength={8000}
            value={soul}
            onChange={event => setSoul(event.target.value)}
            placeholder={t("描述这个 Bot 如何思考、回应与拒绝。", "Describe how this bot thinks, answers, and declines.")}
          />
        </label>
        {!bot && (
          <fieldset className="nw-field bots-members">
            <legend>{t("执行来源", "Execution source")}</legend>
            <label className="bots-member-row"><input type="radio" name="bot-source" checked={backendId === "kernel"} onChange={() => setBackendId("kernel")} />Knorvia</label>
            {backends.filter(backend => backend.installed && backend.capabilities.run === true).map(backend => <label key={backend.backendId} className="bots-member-row"><input type="radio" name="bot-source" checked={backendId === backend.backendId} onChange={() => setBackendId(backend.backendId)} />{backend.label}</label>)}
            <p className="nw-help">
            {t(
              "CLI 模型由该 CLI 的实际配置决定；每个群和私聊单独续接，不修改全局配置。",
              "CLI models follow their actual CLI configuration; groups and direct chats resume separately without changing global settings.",
            )}
            </p>
          </fieldset>
        )}
        {error && (
          <p className="nw-inline-error" role="alert">
            {error}
          </p>
        )}
        <div className="nw-dialog-actions">
          <button type="button" className="nw-button" onClick={close} disabled={pending}>
            {t("取消", "Cancel")}
          </button>
          <button className="nw-button nw-button-primary" disabled={pending || !name.trim()}>
            {pending ? <Loader2 className="nw-spin" size={14} /> : <Check size={14} />}
            {bot ? t("保存", "Save") : t("创建", "Create")}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function GroupEditor({ bots, close, saved }: { bots: NativeBotProfile[]; close: () => void; saved: () => Promise<void> }) {
  const { t, request } = useWorkbench();
  const [title, setTitle] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  return (
    <Modal title={t("新建群聊", "New group")} close={close} busy={pending}>
      <form
        onSubmit={async event => {
          event.preventDefault();
          if (pending || !title.trim() || selected.length === 0) return;
          setPending(true);
          setError("");
          try {
            await request("room/create", { kind: "group", title: title.trim(), botIds: selected });
            await saved();
            close();
          } catch (caught) {
            setError(errorText(caught));
          } finally {
            setPending(false);
          }
        }}
      >
        <label className="nw-field">
          {t("群名称", "Group name")}
          <input
            autoFocus
            required
            maxLength={120}
            value={title}
            onChange={event => setTitle(event.target.value)}
            placeholder={t("例如：毕业论文冲刺组", "e.g. Thesis sprint")}
          />
        </label>
        <fieldset className="nw-field bots-members">
          <legend>{t("成员 Bot（可多选）", "Member bots")}</legend>
          {bots.map(bot => (
            <label key={bot.id} className="bots-member-row">
              <input
                type="checkbox"
                checked={selected.includes(bot.id)}
                onChange={event =>
                  setSelected(current => (event.target.checked ? [...current, bot.id] : current.filter(id => id !== bot.id)))
                }
              />
              <span>
                {bot.name}
                {bot.backendKind === "cli" ? t("（CLI）", " (CLI)") : ""}
              </span>
            </label>
          ))}
        </fieldset>
        {error && (
          <p className="nw-inline-error" role="alert">
            {error}
          </p>
        )}
        <div className="nw-dialog-actions">
          <button type="button" className="nw-button" onClick={close} disabled={pending}>
            {t("取消", "Cancel")}
          </button>
          <button className="nw-button nw-button-primary" disabled={pending || !title.trim() || selected.length === 0}>
            {pending ? <Loader2 className="nw-spin" size={14} /> : <Check size={14} />}
            {t("创建群聊", "Create group")}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function SoulHistory({ bot }: { bot: NativeBotProfile }) {
  const { t } = useWorkbench();
  const history = bot.soulHistory ?? [];
  if (history.length === 0) return null;
  return (
    <section className="bots-soul-history">
      <h3>{t("Soul 修订历史", "Soul revisions")}</h3>
      <ol>
        {[...history].reverse().map(entry => (
          <li key={entry.revision}>
            <header>
              rev {entry.revision} · {storeTime(entry.updatedAt)}
            </header>
            <p>{entry.soul}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

function BotDetail({ botId, back }: { botId: string; back: () => void }) {
  const { t, request } = useWorkbench();
  const router = useRouter();
  const [bot, setBot] = useState<NativeBotProfile>();
  const [bindings, setBindings] = useState<NativeSessionBinding[]>([]);
  const [loading, setLoading] = useState(true);
  const loadGeneration = useRef(0);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    const generation = ++loadGeneration.current;
    setLoading(true);
    setError("");
    try {
      const [nextBot, nextBindings] = await Promise.all([
        request<NativeBotProfile>("bot/read", { botId }),
        request<NativeSessionBinding[]>("sessionBinding/list", { botId }),
      ]);
      if (generation !== loadGeneration.current) return;
      setBot(nextBot);
      setBindings(nextBindings);
    } catch (caught) {
      if (generation !== loadGeneration.current) return;
      setBot(undefined);
      setBindings([]);
      setError(errorText(caught));
    } finally {
      if (generation === loadGeneration.current) setLoading(false);
    }
  }, [request, botId]);
  useEffect(() => {
    setEditing(false);
    void load();
    return () => { loadGeneration.current += 1; };
  }, [load]);
  if (!bot || bot.id !== botId) {
    return (
      <div className="bots-detail">
        <button className="nw-button" onClick={back}>
          {t("返回", "Back")}
        </button>
        {loading || (bot && bot.id !== botId) ? <p className="nw-help" role="status"><Loader2 className="nw-spin" size={16} />{t("正在读取 Bot…", "Loading bot…")}</p> : <><p className="nw-inline-error" role="alert">{error || t("无法读取该 Bot。", "Unable to read this bot.")}</p><button className="nw-button" onClick={() => void load()}><RefreshCw size={15} />{t("重试", "Retry")}</button></>}
      </div>
    );
  }
  return (
    <div className="bots-detail">
      <header className="bots-detail-head">
        <button className="nw-button" onClick={back}>
          {t("返回", "Back")}
        </button>
        <h2>{bot.name}</h2>
        <span className="bots-backend-badge">{bot.backendKind === "cli" ? t("来自本机 CLI", "Local CLI") : "Knorvia"}</span>
        {bot.isDefault ? <span className="bots-backend-badge">{t("默认", "default")}</span> : null}
        <button className="nw-button" onClick={() => setEditing(true)}>
          <Pencil size={14} />
          {t("编辑", "Edit")}
        </button>
        <button className="nw-button nw-button-primary" disabled={busy} onClick={async () => { setBusy(true); try { const room = await request<NativeRoom>("room/ensureDm", { botId }); router.push(`/workbench/bots?room=${encodeURIComponent(room.id)}`); } catch (caught) { setError(errorText(caught)); } finally { setBusy(false); } }}><MessageSquare size={15} />{t("继续对话", "Continue conversation")}</button>
      </header>
      {error && <p className="nw-inline-error" role="alert">{error}</p>}
      <section className="bots-soul">
        <h3>
          {t("性格与边界", "Personality & boundaries")}
        </h3>
        <p>{bot.soul}</p>
      </section>
      <details><summary>{t("查看性格修改记录", "Personality history")}</summary><SoulHistory bot={bot} /></details>
      <details className="bots-bindings"><summary>{t("会话连接与诊断", "Conversation connections & diagnostics")}</summary>
        {bindings.length === 0 && <p className="nw-help">{t("尚未建立会话。", "No session yet.")}</p>}
        <ul>
          {bindings.map(binding => (
            <li key={binding.id}>
              <code>{binding.conversationId}</code>
              <span>
                gen {binding.bindingGeneration} · {binding.status} · {t("已投递", "delivered")} seq {binding.lastDeliveredSeq}
              </span>
              {binding.status === "active" && (
                <button
                  className="nw-button"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await request("sessionBinding/markLost", {
                        bindingId: binding.id,
                        reason: t("用户要求重新锚定", "re-anchor requested by user"),
                        expectedRevision: binding.revision,
                      });
                      await load();
                    } catch (caught) { setError(errorText(caught)); } finally {
                      setBusy(false);
                    }
                  }}
                >
                  {t("断开重锚", "Re-anchor")}
                </button>
              )}
              {binding.lostReason ? <small>{binding.lostReason}</small> : null}
            </li>
          ))}
        </ul>
      </details>
      {editing && bot && (
        <BotEditor
          bot={bot}
          close={() => setEditing(false)}
          saved={async () => {
            await load();
          }}
        />
      )}
    </div>
  );
}

function RoomChat({ conversationId, back }: { conversationId: string; back: () => void }) {
  const { t, request, workspaceId } = useWorkbench();
  const [room, setRoom] = useState<NativeRoom>();
  const [messages, setMessages] = useState<NativeRoomMessage[]>([]);
  const [head, setHead] = useState(0);
  const [draft, setDraft] = useState("");
  const [copied, setCopied] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const [attention, setAttention] = useState<NativeRoomMessage[]>([]);
  const [checkpointOpen, setCheckpointOpen] = useState(false);
  const [summary, setSummary] = useState("");
  const [savingSummary, setSavingSummary] = useState(false);
  const [summaryError, setSummaryError] = useState("");
  const [checkpointBase, setCheckpointBase] = useState<{ head: number; revision: number }>();
  const [readingOlder, setReadingOlder] = useState(false);
  const [displayHead, setDisplayHead] = useState(0);
  const load = useCallback(async () => {
    const [nextRoom, transcript] = await Promise.all([
      request<NativeRoom>("room/read", { conversationId }),
      request<{ messages: NativeRoomMessage[]; head: number; attention?: NativeRoomMessage[] }>("room/messages", { conversationId, latest: true, limit: 200 }),
    ]);
    setRoom(nextRoom);
    setMessages(transcript.messages.filter(message => !(message.meta && typeof message.meta === "object" && !Array.isArray(message.meta) && message.meta.hidden === true)));
    setHead(transcript.head);
    setAttention(transcript.attention ?? []);
  }, [request, conversationId]);
  useEffect(() => {
    void load().catch(caught => setError(errorText(caught)));
    const timer = setInterval(() => {
      void load().catch(() => undefined);
    }, 2500);
    return () => clearInterval(timer);
  }, [load]);
  useEffect(() => {
    if (!readingOlder) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages.length, readingOlder]);
  useEffect(() => {
    if (!head || readingOlder || document.visibilityState !== "visible" || head <= displayHead) return;
    void request("room/markRead", { conversationId, seq: head }).then(() => setDisplayHead(head)).catch(() => undefined);
  }, [request, conversationId, head, readingOlder, displayHead]);

  const bots = useWorkbenchBots();
  const send = async () => {
    const content = draft.trim();
    if (!content || sending) return;
    setSending(true);
    setError("");
    try {
      await request("room/send", {
        conversationId,
        content,
        workspaceId: workspaceId || undefined,
        timeoutSecs: 600,
      });
      setDraft("");
      await load();
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setSending(false);
    }
  };
  return (
    <div className="bots-chat">
      <header className="bots-chat-head">
        <button className="nw-icon bots-back" onClick={back} aria-label={t("返回 Bots", "Back to Bots")}><ArrowLeft size={18} /></button>
        <span className="bots-room-avatar">{room?.kind === "dm" ? <Bot size={22} /> : <Users size={22} />}</span>
        <div className="bots-room-title"><h2>{room?.title ?? t("正在打开对话…", "Opening conversation…")}</h2><p>{room?.kind === "dm" ? t("私人对话 · 保留上下文", "Direct conversation · Context retained") : room ? `${room.members.length} ${t("位成员", "members")} · ${bots.filter(bot => room.members.some(member => member.botId === bot.id)).map(bot => bot.name).join("、")}` : t("正在连接", "Connecting")}</p></div>
        <button
          className="bots-header-action"
          aria-label={room?.kind === "dm" ? t("会话摘要", "Conversation checkpoint") : t("群摘要", "Group checkpoint")}
          title={room?.kind === "dm" ? t("会话摘要", "Conversation checkpoint") : t("群摘要", "Group checkpoint")}
          disabled={!head}
          onClick={() => { if (!room) return; setCheckpointBase({ head, revision: room.revision }); setSummary(room.checkpoints?.at(-1)?.summary ?? ""); setSummaryError(""); setCheckpointOpen(true); }}
        >
          <FileText size={17} /> <span>{room?.kind === "dm" ? t("会话摘要", "Checkpoint") : t("群摘要", "Checkpoint")}</span>
        </button>
        <button
          className="nw-icon bots-interrupt"
          aria-label={t("停止回复", "Stop response")}
          title={t("停止回复", "Stop response")}
          onClick={async () => {
            try {
              await request("room/interrupt", { conversationId });
            } catch (caught) {
              setError(errorText(caught));
            }
          }}
        >
          <Square size={16} />
        </button>
      </header>
      {attention.length > 0 && <section className="bots-attention" aria-label={t("待我处理", "Needs my attention")}>
        <strong>{t("待我处理", "Needs my attention")} · {attention.length}</strong>
        {attention.map(message => <div key={message.id}>
          <p>{message.content}</p>
          <button className="nw-button" onClick={async () => {
            try { await request("room/attention/resolve", { conversationId, messageId: message.id }); await load(); }
            catch (caught) { setError(errorText(caught)); }
          }}>{t("已处理", "Acknowledge")}</button>
        </div>)}
      </section>}
      {room?.checkpoints?.at(-1) && <details className="bots-checkpoint">
        <summary>{t("对话摘要", "Conversation summary")} <span>{t("已保存", "Saved")}</span></summary>
        <p>{room.checkpoints.at(-1)?.summary}</p>
        <small>{t("用户确认的摘要；原始消息仍保留。", "User-authored summary; original messages are retained.")}</small>
      </details>}
      <div className="bots-chat-log" ref={scrollRef} aria-live="polite" onScroll={event => {
        const element = event.currentTarget;
        setReadingOlder(element.scrollHeight - element.scrollTop - element.clientHeight > 60);
      }}>
        {messages.map(message => (
          <article key={message.id} className={`bots-msg is-${message.sender}`}>
            {message.sender !== "user" && <header>
              {message.sender === "bot" && <span className="bots-message-avatar"><Bot size={17} /></span>}
              <strong>
                {message.sender === "system"
                    ? t("系统", "System")
                    : bots.find(bot => bot.id === message.botId)?.name ?? message.botId}
              </strong>
            </header>}
            <div className="bots-message-body">{message.sender === "bot" ? <Markdown text={message.content} /> : <p>{message.content}</p>}</div>
            <footer className="bots-message-foot"><time>{storeTime(message.createdAt)}</time><button type="button" aria-label={t("复制消息", "Copy message")} onClick={() => { void navigator.clipboard.writeText(message.content).then(() => setCopied(message.id)).catch(caught => setError(errorText(caught))); }}>{copied === message.id ? <Check size={13} /> : <Copy size={13} />}</button></footer>
          </article>
        ))}
        {messages.length === 0 && <div className="bots-chat-welcome"><span className="bots-room-avatar">{room?.kind === "dm" ? <Bot size={28} /> : <Users size={28} />}</span><h3>{room?.kind === "dm" ? t("从一个想法开始", "Start with an idea") : t("让想法一起生长", "Make room for ideas")}</h3><p>{room?.kind === "dm" ? t("发送第一条消息，继续与你的 Bot 合作。", "Send a message to start working with your bot.") : t("在下方选择成员，邀请它加入对话。", "Choose a member below to bring them into the conversation.")}</p></div>}
      </div>
      {error && (
        <p className="nw-inline-error" role="alert">
          {error}
        </p>
      )}
      <div className="bots-composer-dock"><form
        className="bots-composer"
        onSubmit={event => {
          event.preventDefault();
          void send();
        }}
      >
        <textarea
          ref={composerRef}
          rows={2}
          aria-label={t("发送给 Bots 的消息", "Message to Bots")}
          value={draft}
          onChange={event => setDraft(event.target.value)}
          placeholder={t("分享想法，或交给 Bots 一件事…", "Share an idea, or give your Bots something to do…")}
          maxLength={8000}
          onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }}
        />
        <div className="bots-composer-toolbar">
          {room?.kind === "group" ? <div className="bots-mention-members" aria-label={t("呼叫群成员", "Call a group member")}>
            {bots.filter(bot => room.members.some(member => member.botId === bot.id)).map(bot => <button key={bot.id} type="button" aria-pressed={draft.includes(`@${bot.name}`)} onClick={() => { setDraft(value => value.includes(`@${bot.name}`) ? value : `@${bot.name} ${value}`); composerRef.current?.focus(); }}>@{bot.name}</button>)}
          </div> : <span className="bots-direct-hint"><Bot size={15} />{room ? bots.find(bot => room.members.some(member => member.botId === bot.id))?.name : "Bot"}</span>}
          <button className="bots-send" aria-label={t("发送消息", "Send message")} disabled={sending || !draft.trim()}>
            {sending ? <Loader2 className="nw-spin" size={19} /> : <ArrowUp size={21} />}
          </button>
        </div>
      </form><p className="bots-compose-hint">{room?.kind === "group" ? t("点击 @ 成员邀请回复 · Enter 发送 · Shift + Enter 换行", "Choose an @member for a reply · Enter to send · Shift + Enter for a new line") : t("Enter 发送 · Shift + Enter 换行", "Enter to send · Shift + Enter for a new line")}</p></div>
      {checkpointOpen && <Modal title={room?.kind === "dm" ? t("保存会话摘要", "Save a conversation checkpoint") : t("保存群摘要", "Save a group checkpoint")} close={() => setCheckpointOpen(false)} busy={savingSummary}>
        <form onSubmit={async event => {
          event.preventDefault();
          if (!room || !checkpointBase || !summary.trim() || savingSummary) return;
          setSavingSummary(true);
          setSummaryError("");
          try {
            await request("room/checkpoint", { conversationId, summary, throughSeq: checkpointBase.head, expectedRevision: checkpointBase.revision });
            setCheckpointOpen(false); await load();
          } catch (caught) { setSummaryError(errorText(caught)); }
          finally { setSavingSummary(false); }
        }}>
          <p className="nw-help">{t("未读的较早内容会以这份摘要交给 Bot。请保留关键决定、约束与待办；原始消息不会删除。", "Bots will use this summary for earlier unread context. Preserve decisions, constraints and open work; originals stay intact.")}</p>
          <label className="nw-field">{t("摘要内容", "Summary")}<textarea autoFocus required aria-label={t("摘要内容", "Summary")} rows={8} maxLength={4000} value={summary} onChange={event => setSummary(event.target.value)} /></label>
          {summaryError && <p className="nw-inline-error" role="alert">{summaryError}</p>}
          <div className="nw-dialog-actions"><button className="nw-button" type="button" disabled={savingSummary} onClick={() => setCheckpointOpen(false)}>{t("取消", "Cancel")}</button><button className="nw-button nw-button-primary" disabled={savingSummary || !summary.trim()}>{savingSummary ? <Loader2 className="nw-spin" size={14} /> : null}{t("保存新版本", "Save new version")}</button></div>
        </form>
      </Modal>}
    </div>
  );
}

function useWorkbenchBots() {
  const { request, connection } = useWorkbench();
  const [bots, setBots] = useState<NativeBotProfile[]>([]);
  useEffect(() => {
    if (connection !== "connected") return;
    void request<NativeBotProfile[]>("bot/list", {})
      .then(setBots)
      .catch(() => setBots([]));
  }, [request, connection]);
  return bots;
}

export function BotsView() {
  const { t, request, connection } = useWorkbench();
  const router = useRouter();
  const searchParams = useSearchParams();
  const selectedRoomId = searchParams.get("room");
  const selectedBotId = searchParams.get("bot");
  const createMode = searchParams.get("create");
  const [bots, setBots] = useState<NativeBotProfile[]>([]);

  const [backends, setBackends] = useState<NativeCliBackendStatus[]>([]);
  const [selected, setSelected] = useState<Selected>();
  const [botEditor, setBotEditor] = useState<{ bot?: NativeBotProfile }>();
  const [groupEditor, setGroupEditor] = useState(false);
  const [error, setError] = useState("");
  const [bootstrapped, setBootstrapped] = useState(false);


  useEffect(() => {
    setSelected(selectedRoomId ? { kind: "room", conversationId: selectedRoomId } : selectedBotId ? { kind: "bot", botId: selectedBotId } : undefined);
  }, [selectedRoomId, selectedBotId]);
  useEffect(() => {
    setBotEditor(createMode === "bot" ? {} : undefined);
    setGroupEditor(createMode === "group");
  }, [createMode]);
  const closeCreate = () => {
    setBotEditor(undefined); setGroupEditor(false);
    const next = new URLSearchParams(searchParams.toString()); next.delete("create");
    router.replace(`/workbench/bots${next.size ? `?${next}` : ""}`);
  };

  const load = useCallback(async () => {
    // Idempotent default bot: safe on every load, exactly one default exists.
    await request("bot/ensureDefault", {});
    const nextBots = await request<NativeBotProfile[]>("bot/list", {});
    setBots(nextBots);
    setBootstrapped(true);
    window.dispatchEvent(new Event("knorvia-bots-changed"));
  }, [request]);

  useEffect(() => {
    if (connection !== "connected") return;
    let active = true;
    void request<{ backends: NativeCliBackendStatus[] }>("cliBackend/list", {}).then(result => { if (active) setBackends(result.backends); }).catch(() => { if (active) setBackends([]); });
    return () => { active = false; };
  }, [connection, request]);

  useEffect(() => {
    if (connection !== "connected") return;
    void load()
      .then(() => setBootstrapped(true))
      .catch(caught => setError(errorText(caught)));
  }, [connection, load]);

  return (
    <div className="nw-page bots-page bots-conversation-page">
      {error && (
        <p className="nw-inline-error" role="alert">
          {error}
        </p>
      )}
      {!bootstrapped && connection === "connected" && (
        <p className="nw-help">
          <Loader2 className="nw-spin" size={13} /> {t("读取名册…", "Loading roster…")}
        </p>
      )}
      <div className="bots-columns">
        <section className="bots-panel">
          {selected?.kind === "bot" && <BotDetail key={selected.botId} botId={selected.botId} back={() => router.push("/workbench/bots")} />}
          {selected?.kind === "room" && (
            <RoomChat key={selected.conversationId} conversationId={selected.conversationId} back={() => router.push("/workbench/bots")} />
          )}
          {!selected && (
            <div className="bots-empty">
              <Bot size={28} />
              <h2>{t("与 Bots 一起工作", "Work with your Bots")}</h2><p>{t("从左侧选择机器人或群聊，继续上次的对话。", "Choose a bot or group in the sidebar to continue your conversation.")}</p><button className="nw-button" onClick={() => router.push("/workbench/bots?create=bot")}><Plus size={15} />{t("新建机器人", "New bot")}</button>
            </div>
          )}
        </section>
      </div>
      {botEditor && (
        <BotEditor
          bot={botEditor.bot}
          backends={backends}
          close={closeCreate}
          saved={async () => {
            await load();
          }}
        />
      )}
      {groupEditor && (
        <GroupEditor
          bots={bots}
          close={closeCreate}
          saved={async () => {
            await load();
          }}
        />
      )}
    </div>
  );
}

// Keep the resolved-binding type import honest: the UI will use it when a
// re-anchor happens in-session; the tree-shaker drops it otherwise.
export type { NativeResolvedBinding };
