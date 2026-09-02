import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  CHAT_CHEATSHEET,
  matchChatShortcut,
} from "../lib/keyboard-cheatsheet";

test("cheatsheet lists new-chat / stop / retry and does not duplicate Ctrl+K", () => {
  const keys = CHAT_CHEATSHEET.map((row) => row.keys);
  assert.deepEqual(
    keys.filter((key) => key === "Ctrl+K"),
    ["Ctrl+K"],
  );
  assert.ok(keys.includes("Ctrl+N"));
  assert.ok(keys.includes("Esc"));
  assert.ok(keys.includes("Ctrl+R"));
});

test("shortcut matcher covers new chat, stop, retry, and question-mark cheatsheet", () => {
  assert.equal(matchChatShortcut({ key: "?", target: null }), "cheatsheet");
  assert.equal(matchChatShortcut({ key: "n", ctrlKey: true }), "new-chat");
  assert.equal(matchChatShortcut({ key: "Escape" }), "stop-generation");
  assert.equal(matchChatShortcut({ key: "r", ctrlKey: true }), "retry");
  assert.equal(matchChatShortcut({ key: "k", ctrlKey: true }), null);
});

test("command palette still owns the only Ctrl+K handler", () => {
  const palette = fs.readFileSync(
    path.join(process.cwd(), "components/common/CommandPalette.tsx"),
    "utf8",
  );
  const sheet = fs.readFileSync(
    path.join(process.cwd(), "components/common/KeyboardCheatsheet.tsx"),
    "utf8",
  );
  const shell = fs.readFileSync(
    path.join(process.cwd(), "components/layout/AppShell.tsx"),
    "utf8",
  );
  assert.match(palette, /key\.toLowerCase\(\) === "k"/);
  assert.doesNotMatch(sheet, /toLowerCase\(\) === "k"/);
  assert.doesNotMatch(shell, /toLowerCase\(\) === "k"/);
});
