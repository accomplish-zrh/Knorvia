export interface ShortcutSpec {
  id: string;
  keys: string;
  label: string;
}

/** App-wide cheatsheet. Ctrl+K stays the existing command palette — do not add a second one. */
export const APP_SHORTCUTS: ShortcutSpec[] = [
  { id: "palette", keys: "Ctrl+K", label: "Command palette" },
  { id: "new-chat", keys: "Ctrl+N", label: "New chat" },
  { id: "stop", keys: "Esc", label: "Stop generation" },
  { id: "retry", keys: "Ctrl+R", label: "Retry" },
  { id: "cheatsheet", keys: "?", label: "Keyboard shortcuts" },
];

export function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  if (!target || typeof target !== "object") return false;
  const el = target as {
    isContentEditable?: boolean;
    tagName?: string;
    closest?: (selector: string) => unknown;
  };
  if (el.isContentEditable) return true;
  const tag = String(el.tagName || "").toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (typeof el.closest === "function") {
    return Boolean(el.closest("input, textarea, select, [contenteditable='true']"));
  }
  return false;
}

export function isModifierOnly(event: KeyboardEvent): boolean {
  return event.metaKey || event.ctrlKey || event.altKey;
}
