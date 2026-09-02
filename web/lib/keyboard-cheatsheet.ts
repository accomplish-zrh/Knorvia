/** Chat keyboard cheatsheet + shortcut matching. Ctrl+K stays unique (palette). */

export type CheatSheetEntry = {
  keys: string;
  action: string;
};

export const CHAT_CHEATSHEET: CheatSheetEntry[] = [
  { keys: "Ctrl+K", action: "Command palette" },
  { keys: "Ctrl+N", action: "New chat" },
  { keys: "Esc", action: "Stop generation" },
  { keys: "Ctrl+R", action: "Retry last reply" },
  { keys: "?", action: "Keyboard shortcuts" },
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
    return Boolean(el.closest('input, textarea, select, [contenteditable="true"]'));
  }
  return false;
}

export function shouldOpenCheatSheet(event: {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  target?: EventTarget | null;
}): boolean {
  if (event.key !== "?") return false;
  if (event.ctrlKey || event.metaKey || event.altKey) return false;
  return !isEditableKeyboardTarget(event.target ?? null);
}

export type ChatShortcut =
  | "new-chat"
  | "stop-generation"
  | "retry"
  | "cheatsheet";

export function matchChatShortcut(event: {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  target?: EventTarget | null;
}): ChatShortcut | null {
  const key = event.key;
  const mod = Boolean(event.ctrlKey || event.metaKey);
  if (mod && !event.altKey && key.toLowerCase() === "n") return "new-chat";
  if (mod && !event.altKey && key.toLowerCase() === "r") return "retry";
  if (key === "Escape" && !mod && !event.altKey) return "stop-generation";
  if (key === "?" && !mod && !event.altKey && !isEditableKeyboardTarget(event.target ?? null)) {
    return "cheatsheet";
  }
  return null;
}
