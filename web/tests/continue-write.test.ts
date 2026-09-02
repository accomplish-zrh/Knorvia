import test from "node:test";
import assert from "node:assert/strict";
import {
  isContinueWritePrompt,
  isTruncatedAssistantMessage,
} from "../lib/continue-write";

test("continue-write phrases map to the same-assistant continue action", () => {
  assert.equal(isContinueWritePrompt("继续写"), true);
  assert.equal(isContinueWritePrompt("继续写。"), true);
  assert.equal(isContinueWritePrompt("  continue writing  "), true);
  assert.equal(isContinueWritePrompt("please continue writing a poem"), false);
  assert.equal(isContinueWritePrompt("hello"), false);
});

test("truncated assistant detection reads finish_reason and notices", () => {
  assert.equal(
    isTruncatedAssistantMessage({
      role: "assistant",
      events: [{ type: "result", metadata: { finish_reason: "length" } }],
    }),
    true,
  );
  assert.equal(
    isTruncatedAssistantMessage({
      role: "assistant",
      events: [
        {
          type: "progress",
          content: "The model output reached its token limit; asked it to continue.",
        },
      ],
    }),
    false,
  );
  assert.equal(
    isTruncatedAssistantMessage({
      role: "assistant",
      events: [{ type: "progress", metadata: { output_truncated: true } }],
    }),
    true,
  );
  assert.equal(
    isTruncatedAssistantMessage({
      role: "assistant",
      events: [{ type: "result", metadata: { finish_reason: "stop" } }],
    }),
    false,
  );
});
