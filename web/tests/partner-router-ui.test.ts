/** Partner router / usage / reactions UI — grok-bot parity regression checks. */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const webRoot = process.cwd();

function read(rel: string) {
  return readFileSync(path.join(webRoot, rel), "utf8");
}

test("partner configure mounts the router and usage sections", () => {
  const configure = read("components/partners/PartnerConfigure.tsx");
  assert.match(configure, /PartnerRouterSection/);
  assert.match(configure, /PartnerUsageSection/);
});

test("router section offers the LLM pipeline and detected CLI backends", () => {
  const section = read("components/partners/PartnerRouterSection.tsx");
  assert.match(section, /data-partner-router=""/);
  assert.match(section, /data-router-option="llm"/);
  assert.match(section, /getRouterBackends/);
  assert.match(section, /Not detected/);
  // Usage panel reads the ledger API and shows token totals.
  assert.match(section, /data-partner-usage=""/);
  assert.match(section, /getPartnerUsage/);
});

test("partner chat supports reactions and a composing typing row", () => {
  const chat = read("components/partners/PartnerChat.tsx");
  assert.match(chat, /togglePartnerReaction/);
  assert.match(chat, /data-message-reactions=""/);
  // Typing dots render before the first streamed token arrives.
  assert.match(chat, /data-typing-dots=""/);
});

test("partners-api exposes the router, usage, and reaction endpoints", () => {
  const api = read("lib/partners-api.ts");
  assert.match(api, /\/router\/backends/);
  assert.match(api, /\/history\/reaction/);
  assert.match(api, /\/usage\?days=/);
  assert.match(api, /routing\?:/);
});
