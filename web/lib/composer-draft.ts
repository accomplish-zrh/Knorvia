/**
 * Cross-page handoff for the chat composer.
 *
 * Pages outside the chat workspace (e.g. the Automations settings page's
 * "Create in chat" action) can stash a draft instruction here before
 * navigating to `/home`; on mount the chat page takes it and prefills the
 * composer — the user still confirms sending. sessionStorage keeps the
 * handoff single-tab and disposable: one stash is consumed exactly once.
 */

const COMPOSER_DRAFT_KEY = "knorvia:composer-draft";

/** Stash *text* for the chat page to pick up after the next navigation. */
export function stashComposerDraft(text: string): void {
  try {
    window.sessionStorage.setItem(COMPOSER_DRAFT_KEY, text);
  } catch {
    /* storage unavailable (private mode, quota) — navigation still works */
  }
}

/**
 * Consume a stashed draft, if any. Returns null when nothing was stashed
 * or storage is unavailable; the key is removed either way it existed.
 */
export function takeComposerDraft(): string | null {
  try {
    const text = window.sessionStorage.getItem(COMPOSER_DRAFT_KEY);
    if (text !== null) window.sessionStorage.removeItem(COMPOSER_DRAFT_KEY);
    return text && text.trim() ? text : null;
  } catch {
    return null;
  }
}
