'use strict';

// C06: notification → task navigation relay for the desktop shell. Validates
// notification thread ids, activates the window, delivers when the workbench
// shell is on screen, and otherwise keeps exactly one bounded pending request
// that replays once the shell finishes loading.

const MAX_ID_LENGTH = 200;
const FORBIDDEN = /[\u0000-\u001f\u007f<>"'\\]/;

function validateOpenThreadId(threadId) {
  if (typeof threadId !== 'string') return null;
  const id = threadId.trim();
  if (!id || id.length > MAX_ID_LENGTH || FORBIDDEN.test(id)) return null;
  return id;
}

function createOpenThreadBridge({
  deliver,
  isShellReady,
  activate = () => {},
  ttlMs = 5 * 60 * 1000,
  now = () => Date.now(),
} = {}) {
  if (typeof deliver !== 'function' || typeof isShellReady !== 'function') throw new Error('deliver and isShellReady are required');
  let pending = null;
  return {
    open(threadId) {
      const id = validateOpenThreadId(threadId);
      if (!id) return 'rejected';
      activate();
      if (!isShellReady()) {
        pending = { threadId: id, at: now() };
        return 'buffered';
      }
      deliver(id);
      return 'delivered';
    },
    // Shell did-finish-load: replay at most one pending id, and only while it
    // is still fresh and the shell is really the current page. A load that is
    // not the workbench shell (loading/recovery page) keeps the request
    // buffered for the eventual shell load.
    flush() {
      if (!pending) return null;
      const { threadId, at } = pending;
      if (now() - at > ttlMs) {
        pending = null;
        return null;
      }
      if (!isShellReady()) return null;
      pending = null;
      deliver(threadId);
      return threadId;
    },
    get pending() { return Boolean(pending); },
    clear() { pending = null; },
  };
}

module.exports = { createOpenThreadBridge, validateOpenThreadId, MAX_ID_LENGTH };
