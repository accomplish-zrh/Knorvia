import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

test("co-writer document page is left editor + right chat/citations", () => {
  const page = fs.readFileSync(
    path.join(process.cwd(), "app/(workspace)/co-writer/[docId]/page.tsx"),
    "utf8",
  );
  assert.match(page, /CoWriterChatPanel/);
  assert.match(page, /rightPane/);
  assert.match(page, /setRightPane\("chat"\)/);
  assert.match(page, /textarea/);
});

test("home Co-Writer split keeps existing chat mounted", () => {
  const split = fs.readFileSync(
    path.join(process.cwd(), "components/chat/home/CoWriterSplit.tsx"),
    "utf8",
  );
  assert.match(split, /Does not unmount the chat tree/);
  assert.match(split, /\{children\}/);
});

test("campus assistants were removed from chat home", () => {
  const page = fs.readFileSync(
    path.join(process.cwd(), "app/(workspace)/home/[[...sessionId]]/page.tsx"),
    "utf8",
  );
  assert.doesNotMatch(page, /CampusAssistants/);
  assert.doesNotMatch(page, /campus-assistants/);
});
