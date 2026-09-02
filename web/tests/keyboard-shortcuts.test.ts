import test from "node:test";
import assert from "node:assert/strict";

import { APP_SHORTCUTS, isEditableKeyboardTarget } from "../lib/keyboard-shortcuts";

test("cheatsheet lists Ctrl+N, Esc, Ctrl+R and keeps a single Ctrl+K", () => {
  const keys = APP_SHORTCUTS.map((item) => item.keys);
  assert.deepEqual(keys, ["Ctrl+K", "Ctrl+N", "Esc", "Ctrl+R", "?"]);
  assert.equal(keys.filter((key) => key === "Ctrl+K").length, 1);
});

test("question-mark cheatsheet is suppressed for editable targets", () => {
  const input = { isContentEditable: false, tagName: "INPUT", closest: () => null };
  const div = { isContentEditable: false, tagName: "DIV", closest: () => null };
  assert.equal(isEditableKeyboardTarget(input as unknown as EventTarget), true);
  assert.equal(isEditableKeyboardTarget(div as unknown as EventTarget), false);
  assert.equal(isEditableKeyboardTarget(null), false);
});
