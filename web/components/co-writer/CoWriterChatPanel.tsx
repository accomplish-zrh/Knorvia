"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { BookOpen, Loader2, Send, SquarePen } from "lucide-react";

import {
  getCoWriterChat,
  postCoWriterChat,
  type CoWriterChatMessage,
} from "@/lib/co-writer-api";

export default function CoWriterChatPanel({
  docId,
  onInsert,
}: {
  docId: string;
  onInsert?: (markdown: string) => void;
}) {
  const { t } = useTranslation();
  const [messages, setMessages] = useState<CoWriterChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [openCite, setOpenCite] = useState<number | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    void getCoWriterChat(docId)
      .then((rows) => {
        if (!cancelled) setMessages(rows);
      })
      .catch(() => {
        if (!cancelled) setMessages([]);
      });
    return () => {
      cancelled = true;
    };
  }, [docId]);

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, busy]);

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true);
    setError("");
    setDraft("");
    setMessages((prev) => [
      ...prev,
      { role: "user", content: text, citations: [] },
    ]);
    try {
      const result = await postCoWriterChat(docId, text);
      setMessages(result.messages);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [busy, docId, draft]);

  return (
    <div
      className="flex min-h-0 flex-1 flex-col bg-transparent"
      data-testid="cowriter-chat-panel"
    >
      <div ref={scroller} className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {messages.length === 0 && !busy ? (
          <p className="px-1 text-[12.5px] leading-relaxed text-[var(--muted-foreground)]">
            {t("Ask about this paper")}
          </p>
        ) : null}
        {messages.map((msg, idx) => (
          <div
            key={msg.role + "-" + String(idx)}
            className={
              msg.role === "user"
                ? "ml-8 rounded-xl bg-[var(--primary)]/12 px-3 py-2 text-[13px] leading-relaxed text-[var(--foreground)]"
                : "mr-4 rounded-xl border border-[var(--border)]/70 bg-[var(--card)]/55 px-3 py-2 text-[13px] leading-relaxed text-[var(--foreground)]"
            }
          >
            <div className="whitespace-pre-wrap break-words">{msg.content}</div>
            {msg.role === "assistant" &&
            msg.citations &&
            msg.citations.length > 0 ? (
              <div className="mt-2 rounded-lg border border-[var(--border)]/60 bg-[var(--background)]/40">
                <div className="flex items-center gap-1.5 px-2 pt-1.5 text-[10.5px] font-medium uppercase tracking-wide text-[var(--muted-foreground)]">
                  <BookOpen size={11} />
                  {t("Citations")}
                </div>
                <div className="flex flex-col gap-0.5 p-1.5">
                  {msg.citations.map((cite, cidx) => {
                    const open = openCite === idx * 100 + cidx;
                    return (
                      <button
                        key={cite.title + "-" + String(cidx)}
                        type="button"
                        onClick={() =>
                          setOpenCite(open ? null : idx * 100 + cidx)
                        }
                        className="rounded-md px-2 py-1 text-left hover:bg-[var(--muted)]/40"
                      >
                        <span className="block truncate text-[12px] font-medium">
                          [{cidx + 1}] {cite.title}
                        </span>
                        {open && cite.content ? (
                          <span className="mt-0.5 block text-[11px] text-[var(--muted-foreground)]">
                            {cite.content}
                          </span>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : null}
            {msg.role === "assistant" && onInsert ? (
              <button
                type="button"
                onClick={() => onInsert(msg.content)}
                className="mt-1.5 inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-[var(--muted-foreground)] hover:bg-[var(--muted)]/50 hover:text-[var(--foreground)]"
              >
                <SquarePen size={11} />
                {t("Insert into document")}
              </button>
            ) : null}
          </div>
        ))}
        {busy ? (
          <div className="inline-flex items-center gap-1.5 text-[12px] text-[var(--muted-foreground)]">
            <Loader2 size={12} className="animate-spin" />
            {t("Thinking...")}
          </div>
        ) : null}
        {error ? (
          <p className="text-[12px] text-[var(--destructive)]">{error}</p>
        ) : null}
      </div>
      <form
        className="flex shrink-0 items-end gap-2 border-t border-[var(--border)]/70 p-2"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
          placeholder={t("Ask about this paper")}
          rows={2}
          className="min-h-[44px] min-w-0 flex-1 resize-none rounded-xl border border-[var(--border)] bg-[var(--background)]/50 px-3 py-2 text-[13px] outline-none focus:border-[var(--ring)]"
        />
        <button
          type="submit"
          disabled={busy || !draft.trim()}
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--primary)] text-[var(--primary-foreground)] disabled:opacity-40"
          aria-label={t("Send")}
        >
          <Send size={14} />
        </button>
      </form>
    </div>
  );
}
