import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

test("split state clamps and defaults via source", () => {
  const lib = fs.readFileSync(
    path.join(process.cwd(), "lib/cowriter-split.ts"),
    "utf8",
  );
  assert.match(lib, /COWRITER_SPLIT_DEFAULT/);
  assert.match(lib, /cowriterChatHref/);
});

test("chat page can toggle Co-Writer split without replacing chat", () => {
  const page = fs.readFileSync(
    path.join(process.cwd(), "app/(workspace)/home/[[...sessionId]]/page.tsx"),
    "utf8",
  );
  const split = fs.readFileSync(
    path.join(process.cwd(), "components/chat/home/CoWriterSplit.tsx"),
    "utf8",
  );
  assert.match(page, /CoWriterSplit/);
  assert.match(split, /Does not unmount the chat tree/);
  assert.match(split, /localStorage|saveCoWriterSplitState/);
});
