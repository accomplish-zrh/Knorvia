import test from "node:test";
import assert from "node:assert/strict";

import { capabilityForPath } from "../lib/capability-routes";

// ── capabilityForPath ──────────────────────────────────────────────────

test("capabilityForPath maps LLM features to llm", () => {
  assert.equal(capabilityForPath("/home"), "llm");
  assert.equal(capabilityForPath("/partners"), "llm");
  assert.equal(capabilityForPath("/co-writer"), "llm");
  assert.equal(capabilityForPath("/book"), "llm");
  assert.equal(capabilityForPath("/space/learning"), "llm"); // Mastery Path
  assert.equal(capabilityForPath("/playground"), "llm");
});

test("capabilityForPath gates each media workbench independently", () => {
  assert.equal(capabilityForPath("/image-studio"), "imagegen");
  assert.equal(capabilityForPath("/video-studio"), "videogen");
  assert.equal(capabilityForPath("/video-studio/project-1"), "videogen");
});

test("capabilityForPath matches nested routes by prefix", () => {
  assert.equal(capabilityForPath("/home/abc-123"), "llm");
  assert.equal(capabilityForPath("/partners/partner-1"), "llm");
  assert.equal(capabilityForPath("/space/learning/book-1"), "llm");
});

test("capabilityForPath matches on a segment boundary, not a bare prefix", () => {
  // A sibling route must never be swallowed by a shorter gated prefix.
  assert.equal(capabilityForPath("/booket"), null);
  assert.equal(capabilityForPath("/homepage"), null);
  assert.equal(capabilityForPath("/playgrounds-xyz"), null);
  // The gated route itself and its children still match.
  assert.equal(capabilityForPath("/book"), "llm");
  assert.equal(capabilityForPath("/book/123"), "llm");
});

test("capabilityForPath returns null for ungated routes", () => {
  // Knowledge is ungated: embedding is shared admin infra, not per-user.
  assert.equal(capabilityForPath("/knowledge"), null);
  assert.equal(capabilityForPath("/memory"), null);
  assert.equal(capabilityForPath("/space"), null);
  assert.equal(capabilityForPath("/settings"), null);
  assert.equal(capabilityForPath("/create"), null);
  assert.equal(capabilityForPath("/library"), null);
});
