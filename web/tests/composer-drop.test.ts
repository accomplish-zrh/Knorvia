import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

test("composer drop is turn-only and never knowledge ingest", () => {
  const composer = fs.readFileSync(
    path.join(process.cwd(), "components/chat/home/ChatComposer.tsx"),
    "utf8",
  );
  const home = fs.readFileSync(
    path.join(process.cwd(), "app/(workspace)/home/[[...sessionId]]/page.tsx"),
    "utf8",
  );
  assert.match(composer, /onDrop=\{onDrop\}/);
  assert.match(composer, /Attach to this turn only/);
  assert.match(home, /Attach to this turn only/);
  assert.match(home, /setAttachments/);
  assert.doesNotMatch(home, /createKnowledgeBase/);
});
