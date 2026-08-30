/** AI Classroom (OpenMAIC-inspired) UI/API structure checks. */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const webRoot = process.cwd();

function read(rel: string) {
  return readFileSync(path.join(webRoot, rel), "utf8");
}

test("classroom api client covers generation, playback, discussion, grading", () => {
  const api = read("lib/classroom-api.ts");
  assert.match(api, /\/api\/v1\/classroom\/generate/);
  assert.match(api, /\/discussion/);
  assert.match(api, /\/grade/);
  // SSE reader + stateless round-trip state (OpenMAIC protocol parity).
  assert.match(api, /readSse/);
  assert.match(api, /turn_count/);
  assert.match(api, /summaries/);
});

test("classroom player walks an action timeline with quiz and discussion", () => {
  const player = read("components/classroom/ClassroomPlayer.tsx");
  assert.match(player, /data-classroom-player=""/);
  assert.match(player, /data-classroom-quiz=""/);
  assert.match(player, /data-classroom-discussion=""/);
  // Speech beat is derived from text length (no TTS dependency).
  assert.match(player, /speechBeatMs/);
  // Discussion state round-trips; consumed discussions do not replay.
  assert.match(player, /consumedDiscussions/);
});

test("space dashboard links the AI classroom", () => {
  const dashboard = read("components/space/SpaceDashboard.tsx");
  assert.match(dashboard, /\/space\/classroom/);
  assert.match(dashboard, /listClassrooms/);
});
