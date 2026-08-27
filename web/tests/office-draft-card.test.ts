import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  canConfirmOfficeDraft,
  collectOfficeDrafts,
  isOfficeDraftTerminal,
  patchOfficeDraft,
} from "../lib/office-draft";
import { hasChatTaskCards } from "../lib/chat-task-cards";
import type { StreamEvent } from "../lib/unified-ws";

function event(
  type: StreamEvent["type"],
  metadata: Record<string, unknown>,
): StreamEvent {
  return {
    type,
    source: "chat",
    stage: "responding",
    content: "",
    metadata,
    session_id: "session-1",
    turn_id: "turn-1",
    seq: 1,
    timestamp: 0,
  };
}

test("collectOfficeDrafts renders draft, ready, and merged states", () => {
  const draftEvents = [
    event("tool_result", {
      tool_metadata: {
        office_draft: {
          draft_id: "abcd1234",
          status: "draft",
          files: [{ name: "report.xlsx", url: "/api/outputs/report.xlsx" }],
        },
      },
    }),
  ];
  const readyEvents = [
    ...draftEvents,
    event("progress", {
      office_draft: {
        draft_id: "abcd1234",
        status: "ready",
        files: [{ name: "report.xlsx", url: "/api/outputs/report.xlsx" }],
      },
    }),
  ];
  const mergedEvents = [
    ...readyEvents,
    event("progress", {
      office_draft: { draft_id: "abcd1234", status: "merged", files: [] },
    }),
  ];

  const draft = collectOfficeDrafts(draftEvents)[0];
  const ready = collectOfficeDrafts(readyEvents)[0];
  const merged = collectOfficeDrafts(mergedEvents)[0];

  assert.equal(draft.status, "draft");
  assert.equal(draft.files[0].name, "report.xlsx");
  assert.equal(canConfirmOfficeDraft(draft.status), true);
  assert.equal(ready.status, "ready");
  assert.equal(canConfirmOfficeDraft(ready.status), true);
  assert.equal(merged.status, "merged");
  assert.equal(isOfficeDraftTerminal(merged.status), true);
  assert.equal(canConfirmOfficeDraft(merged.status), false);
  assert.equal(hasChatTaskCards(draftEvents), true);
});

test("collectOfficeDrafts surfaces discarded terminal badge state", () => {
  const events = [
    event("tool_result", {
      draft_id: "deadbeef",
      draft_status: "discarded",
      files: [{ name: "notes.docx", url: "/api/outputs/notes.docx" }],
    }),
  ];
  const [card] = collectOfficeDrafts(events);
  assert.equal(card.draftId, "deadbeef");
  assert.equal(card.status, "discarded");
  assert.equal(isOfficeDraftTerminal(card.status), true);
  assert.equal(canConfirmOfficeDraft(card.status), false);
});

test("patchOfficeDraft button callbacks PATCH merge and discard", async () => {
  const calls: Array<{ url: string; method: string; body: string }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: String(init?.method || "GET"),
      body: String(init?.body || ""),
    });
    const action = String(init?.body || "").includes("discard") ? "discarded" : "merged";
    return new Response(JSON.stringify({ draft_id: "abcd1234", status: action, files: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  try {
    const merged = await patchOfficeDraft("abcd1234", "merge");
    const discarded = await patchOfficeDraft("abcd1234", "discard");
    assert.equal(merged.status, "merged");
    assert.equal(discarded.status, "discarded");
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(calls.length, 2);
  assert.equal(calls[0].method, "PATCH");
  assert.equal(calls[0].url, "/api/v1/chat/office-drafts/abcd1234");
  assert.match(calls[0].body, /merge/);
  assert.equal(calls[1].url, "/api/v1/chat/office-drafts/abcd1234");
  assert.match(calls[1].body, /discard/);
});

test("OfficeDraftCard source wires three states and destructive discard", () => {
  const source = readFileSync(
    join(process.cwd(), "components", "chat", "home", "OfficeDraftCard.tsx"),
    "utf8",
  );
  assert.match(source, /Confirm merge/);
  assert.match(source, /Discard draft/);
  assert.match(source, /Waiting for confirmation/);
  assert.match(source, /Office draft merged/);
  assert.match(source, /Office draft discarded/);
  assert.match(source, /var\(--destructive\)/);
  assert.match(source, /patchOfficeDraft\(draftId, action\)/);
  const trace = readFileSync(
    join(process.cwd(), "components", "chat", "home", "TracePanels.tsx"),
    "utf8",
  );
  assert.match(trace, /OfficeDraftCards/);
});
