"use client";

/**
 * Headless bridge components + the header action button extracted from the
 * home chat page (architecture line budget): they glue page-level refs to
 * context controllers without rendering anything themselves.
 */

import { useEffect, useRef, type MutableRefObject } from "react";
import type { LucideIcon } from "lucide-react";
import Tooltip from "@/components/common/Tooltip";
import type { SessionViewerPanelHandle } from "@/components/chat/home/SessionViewerPanel";
import { useQuizFollowupController } from "@/context/QuizFollowupContext";
import { useGeogebraTabOpener } from "@/context/GeogebraTabContext";
import type { StreamEvent } from "@/lib/unified-ws";

/**
 * Wires the quiz-followup controller's open-tab request to the session
 * viewer panel without prop-drilling the handler down through several
 * layers of components.
 */
export function QuizFollowupBridge({
  viewerPanelRef,
}: {
  viewerPanelRef: MutableRefObject<SessionViewerPanelHandle | null>;
}) {
  const controller = useQuizFollowupController();
  useEffect(() => {
    controller.setOpenTabHandler((ctx) => {
      viewerPanelRef.current?.openQuizFollowupTab(ctx);
    });
    return () => controller.setOpenTabHandler(null);
  }, [controller, viewerPanelRef]);
  return null;
}

/**
 * Same shape as QuizFollowupBridge, for the GeoGebra-tab opener exposed
 * to in-message CTAs (the ``ggbscript`` markdown fence becomes a card
 * that calls ``controller.openTab(...)`` here).
 */
export function GeogebraTabBridge({
  viewerPanelRef,
}: {
  viewerPanelRef: MutableRefObject<SessionViewerPanelHandle | null>;
}) {
  const controller = useGeogebraTabOpener();
  useEffect(() => {
    if (!controller) return;
    controller.setOpenHandler((payload) => {
      viewerPanelRef.current?.openGeogebraTab(payload);
    });
    return () => controller.setOpenHandler(null);
  }, [controller, viewerPanelRef]);
  return null;
}

/**
 * Watches the turn's messages for connected-subagent runs and mirrors each
 * (grouped by the consult's call id) into its own side-viewer tab — opening +
 * focusing the panel when a consult starts, then live-refreshing as the
 * agent's native events stream in. Keeps the chat trace compact while the full
 * run shows in the sidebar.
 */
export function SubagentTabWatcher({
  messages,
  viewerPanelRef,
}: {
  messages: { events?: StreamEvent[] }[];
  viewerPanelRef: MutableRefObject<SessionViewerPanelHandle | null>;
}) {
  // Per-group event counts already pushed to the panel. The effect re-runs
  // on every stream event; without this guard it re-walks the whole
  // transcript AND re-opens every tab on each token burst.
  const pushedCountsRef = useRef(new Map<string, number>());
  useEffect(() => {
    // Group by turn so all of one turn's consults (Knorvia may ask the agent
    // several questions in a row, each its own tool call) land in one tab as a
    // single running dialogue; fall back to the call id when no turn is set.
    const groups = new Map<string, { label: string; events: StreamEvent[] }>();
    for (const msg of messages) {
      for (const ev of msg.events ?? []) {
        const meta = (ev.metadata ?? {}) as Record<string, unknown>;
        if (meta.trace_kind !== "subagent_event") continue;
        const key = String(meta.turn_id || meta.call_id || meta.trace_id || "");
        if (!key) continue;
        const existing = groups.get(key);
        const label = String(
          meta.subagent_name || existing?.label || "Subagent",
        );
        if (existing) {
          existing.label = label;
          existing.events.push(ev);
        } else {
          groups.set(key, { label, events: [ev] });
        }
      }
    }
    for (const [key, group] of groups) {
      // Push a group only once its event count changed — new events for an
      // unchanged group are already visible in the panel's live stream.
      if (pushedCountsRef.current.get(key) === group.events.length) continue;
      pushedCountsRef.current.set(key, group.events.length);
      viewerPanelRef.current?.openSubagentTab(key, group.label, group.events);
    }
  }, [messages, viewerPanelRef]);
  return null;
}

/**
 * Header action button that auto-collapses to icon-only when the chat
 * column gets squeezed (Viewer panel open, narrow viewport, etc.). The
 * label stays as the button's `title` so hovering an icon still reveals
 * what it does. Optional `active` flag paints the button with a primary
 * tint, used by the panel-toggle buttons to surface their on/off state.
 */
// Claude-style icon-only header action: bare 16px glyph, function revealed
// by an instant tooltip; active state gets a primary tint.
export function HeaderActionButton({
  onClick,
  disabled,
  active,
  icon: Icon,
  label,
  title,
}: {
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  icon: LucideIcon;
  label: string;
  title?: string;
}) {
  return (
    <Tooltip label={title ?? label} side="bottom">
      <button
        onClick={onClick}
        disabled={disabled}
        aria-label={label}
        aria-pressed={active}
        className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-[background-color,color,transform] duration-150 active:scale-90 disabled:cursor-not-allowed disabled:opacity-40 ${
          active
            ? "bg-[var(--primary)]/10 text-[var(--primary)]"
            : "text-[var(--muted-foreground)] hover:bg-[var(--muted)]/55 hover:text-[var(--foreground)] disabled:hover:bg-transparent disabled:hover:text-[var(--muted-foreground)]"
        }`}
      >
        <Icon size={16} strokeWidth={1.7} className="shrink-0" />
      </button>
    </Tooltip>
  );
}
