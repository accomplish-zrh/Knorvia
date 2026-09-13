"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Download, Search, X } from "lucide-react";
import type { Terminal } from "@xterm/xterm";
import { buildLogicalLines, exportRetainedLog, findMatches, type BufferLike } from "@/lib/native-terminal-search";
import { useWorkbench } from "./NativeWorkbenchProvider";

/** Adapt the live xterm buffer to the structural shape the search lib reads. */
function toBufferLike(term: Terminal): BufferLike {
  const buffer = term.buffer.active;
  return {
    height: buffer.length,
    getLine: y => {
      const line = buffer.getLine(y);
      if (!line) return undefined;
      return {
        length: line.length,
        isWrapped: line.isWrapped,
        translateToString: (trimRight?: boolean) => line.translateToString(trimRight ?? false),
        getChars: x => line.getCell(x)?.getChars() ?? "",
      };
    },
  };
}

/**
 * Terminal log tools (B13): buffer search with selection-based highlight and
 * a provenance-stamped download of the retained log. Both features read the
 * public xterm buffer only — they never write to the shell — and their state
 * resets whenever the session changes or the screen is cleared (resetSignal).
 */
export function TerminalLogTools({ getTerminal, sessionId, truncated, resetSignal }: {
  getTerminal: () => Terminal | null;
  sessionId: string;
  truncated: boolean;
  resetSignal: number;
}) {
  const { t } = useWorkbench();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<ReturnType<typeof findMatches>>([]);
  const [current, setCurrent] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();

  useEffect(() => {
    // A new session or a cleared/reconnected screen invalidates every match
    // coordinate, so the search state resets instead of highlighting stale rows.
    setMatches([]); setCurrent(0); setQuery("");
  }, [sessionId, resetSignal]);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); close(); }
    };
    document.addEventListener("keydown", escape, true);
    return () => document.removeEventListener("keydown", escape, true);
  }, [open]);

  const runSearch = (text: string) => {
    setQuery(text);
    const term = getTerminal();
    if (!term || !text.trim()) { setMatches([]); setCurrent(0); return; }
    const buffer = toBufferLike(term);
    const lines = buildLogicalLines(buffer);
    const found = findMatches(buffer, lines, text);
    setMatches(found);
    setCurrent(0);
    if (found.length) highlight(found[0]);
  };

  const highlight = (match: { row: number; column: number; length: number }) => {
    const term = getTerminal();
    if (!term) return;
    term.scrollToLine(match.row);
    term.select(match.column, match.row, match.length);
  };

  const step = (direction: 1 | -1) => {
    if (!matches.length) return;
    const next = (current + direction + matches.length) % matches.length;
    setCurrent(next);
    highlight(matches[next]);
  };

  const close = () => {
    setOpen(false);
    getTerminal()?.clearSelection();
    getTerminal()?.focus();
  };

  const download = () => {
    const term = getTerminal();
    if (!term) return;
    const { content } = exportRetainedLog(toBufferLike(term), {
      sessionId, exportedAt: new Date().toISOString(), truncated,
    });
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `knorvia-terminal-${sessionId}-${Date.now()}.log`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const counter = useMemo(() => matches.length ? `${current + 1}/${matches.length}` : query.trim() ? "0" : "", [matches, current, query]);

  return <div className="nw-terminal-logtools">
    <button className="nw-icon" onClick={() => (open ? close() : setOpen(true))} aria-expanded={open} aria-controls={`${inputId}-panel`} title={t("在缓冲区中查找", "Find in buffer")} aria-label={t("在缓冲区中查找", "Find in buffer")}><Search size={14} /></button>
    <button className="nw-icon" onClick={download} title={t("导出当前保留的日志（含会话与截断信息）", "Export the retained log (with session and truncation info)")} aria-label={t("导出保留日志", "Export retained log")}><Download size={14} /></button>
    {open && <div id={`${inputId}-panel`} className="nw-terminal-findbar" role="search">
      <Search size={13} />
      <input
        ref={inputRef}
        value={query}
        placeholder={t("查找（大小写不敏感）", "Find (case-insensitive)")}
        aria-label={t("查找终端缓冲区", "Find in terminal buffer")}
        onChange={event => runSearch(event.target.value)}
        onKeyDown={event => {
          if (event.key === "Enter") { event.preventDefault(); step(event.shiftKey ? -1 : 1); }
        }}
      />
      <span role="status" aria-label={t("匹配数", "Match count")}>{counter}</span>
      <button className="nw-icon" disabled={!matches.length} onClick={() => step(-1)} aria-label={t("上一个匹配", "Previous match")}><ArrowUp size={13} /></button>
      <button className="nw-icon" disabled={!matches.length} onClick={() => step(1)} aria-label={t("下一个匹配", "Next match")}><ArrowDown size={13} /></button>
      <button className="nw-icon" onClick={close} aria-label={t("关闭查找", "Close find")}><X size={13} /></button>
    </div>}
  </div>;
}
