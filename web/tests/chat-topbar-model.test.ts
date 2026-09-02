import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

test("chat top bar switches among locally configured models", () => {
  const page = fs.readFileSync(
    path.join(process.cwd(), "app/(workspace)/home/[[...sessionId]]/page.tsx"),
    "utf8",
  );
  const selector = fs.readFileSync(
    path.join(process.cwd(), "components/chat/home/ModelSelector.tsx"),
    "utf8",
  );
  assert.match(page, /data-testid="chat-topbar-model"/);
  assert.match(page, /<ModelSelector/);
  assert.match(page, /alwaysShowLabel/);
  assert.match(selector, /alwaysShowLabel/);

  assert.match(selector, /groupLLMOptionsByProvider/);
  assert.doesNotMatch(page, /\/settings\/llm/);
  assert.doesNotMatch(page, /\/login/);
  assert.doesNotMatch(page, /wallet|subscription|Sign in to switch models/i);
});
