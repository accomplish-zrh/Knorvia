/**
 * Co-Writer left/right split (Obsidian-style paper writing layout).
 *
 * Left = document editor, right = chat/citations. Widths persist in
 * localStorage. Toggle from chat; existing chat stays mounted on the right.
 */

export const COWRITER_SPLIT_STORAGE_KEY = "knorvia.cowriter.chat_split";
export const COWRITER_SPLIT_MIN = 0.22;
export const COWRITER_SPLIT_MAX = 0.72;
export const COWRITER_SPLIT_DEFAULT = 0.42;

export interface CoWriterSplitState {
  open: boolean;
  /** Co-Writer document id, empty until the first save/create. */
  docId: string;
  ratio: number;
}

const EMPTY: CoWriterSplitState = {
  open: false,
  docId: "",
  ratio: COWRITER_SPLIT_DEFAULT,
};

function clampRatio(value: number): number {
  if (!Number.isFinite(value)) return COWRITER_SPLIT_DEFAULT;
  return Math.min(COWRITER_SPLIT_MAX, Math.max(COWRITER_SPLIT_MIN, value));
}

export function parseCoWriterSplitState(raw: unknown): CoWriterSplitState {
  if (!raw || typeof raw !== "object") return { ...EMPTY };
  const rec = raw as Record<string, unknown>;
  return {
    open: rec.open === true,
    docId: typeof rec.docId === "string" ? rec.docId : "",
    ratio: clampRatio(
      typeof rec.ratio === "number" ? rec.ratio : COWRITER_SPLIT_DEFAULT,
    ),
  };
}

export function loadCoWriterSplitState(): CoWriterSplitState {
  if (typeof window === "undefined") return { ...EMPTY };
  try {
    const raw = window.localStorage.getItem(COWRITER_SPLIT_STORAGE_KEY);
    if (!raw) return { ...EMPTY };
    return parseCoWriterSplitState(JSON.parse(raw));
  } catch {
    return { ...EMPTY };
  }
}

export function saveCoWriterSplitState(
  state: CoWriterSplitState,
): CoWriterSplitState {
  const next = parseCoWriterSplitState(state);
  if (typeof window !== "undefined") {
    window.localStorage.setItem(
      COWRITER_SPLIT_STORAGE_KEY,
      JSON.stringify(next),
    );
  }
  return next;
}

export function cowriterChatHref(docId: string): string {
  const id = (docId || "").trim();
  return id ? "/?cowriter=" + encodeURIComponent(id) : "/?cowriter=1";
}
