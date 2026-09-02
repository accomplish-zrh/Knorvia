import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

test("continue-write appends to the same assistant message", () => {
  const ctx = fs.readFileSync(path.join(process.cwd(), "context/UnifiedChatContext.tsx"), "utf8");
  const ws = fs.readFileSync(path.join(process.cwd(), "lib/unified-ws.ts"), "utf8");
  const messages = fs.readFileSync(
    path.join(process.cwd(), "components/chat/home/ChatMessages.tsx"),
    "utf8",
  );
  assert.match(ctx, /type: "STREAM_CONTINUE"/);
  assert.match(ctx, /type: "continue"/);
  assert.match(ctx, /isContinueWritePrompt/);
  assert.match(ctx, /llm_selection: session\.llmSelection/);
  assert.match(ws, /type: "continue"/);
  assert.match(messages, /Continue writing/);
  assert.match(messages, /isTruncatedAssistantMessage/);
});

test("502 and timeout auto-retry twice before the existing retry button", () => {
  const ctx = fs.readFileSync(path.join(process.cwd(), "context/UnifiedChatContext.tsx"), "utf8");
  const retry = fs.readFileSync(path.join(process.cwd(), "lib/generation-retry.ts"), "utf8");
  const messages = fs.readFileSync(
    path.join(process.cwd(), "components/chat/home/ChatMessages.tsx"),
    "utf8",
  );
  assert.match(ctx, /reduceRetryBudget/);
  assert.match(ctx, /preserveRetryBudget/);
  assert.match(ctx, /type: "done"/);
  assert.match(ctx, /type: "regenerate"/);
  assert.match(ctx, /llm_selection: session\.llmSelection/);
  assert.match(retry, /EXTRA_GENERATION_RETRIES = 2/);
  assert.match(retry, /isRetryableGenerationError/);
  assert.match(retry, /export function reduceRetryBudget/);
  assert.match(messages, /t\('Retry'\)/);
});

test("detect-and-connect keeps the full local CLI catalog including unavailable kinds", () => {
  const agents = fs.readFileSync(
    path.join(process.cwd(), "components/agents/ConnectedAgents.tsx"),
    "utf8",
  );
  assert.match(agents, /setBackends\(found\)/);
  assert.doesNotMatch(agents, /found\.filter\(\(backend\) => backend\.available\)/);
  assert.match(agents, /backend\.available \?/);
  assert.match(agents, /zh: "未安装"/);
});

test("top-bar model switcher still consumes llm-options including local probes", () => {
  const page = fs.readFileSync(
    path.join(process.cwd(), "app/(workspace)/home/[[...sessionId]]/page.tsx"),
    "utf8",
  );
  const llm = fs.readFileSync(path.join(process.cwd(), "lib/llm-options.ts"), "utf8");
  assert.match(page, /data-testid="chat-topbar-model"/);
  assert.match(page, /<ModelSelector/);
  assert.match(llm, /\/api\/v1\/settings\/llm-options/);
});
