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

test("generation runs as a durable job with replayable events (T2)", () => {
  const api = read("lib/classroom-api.ts");
  // POST /generate returns a job_id; snapshot + SSE replay endpoints exist.
  assert.match(api, /startClassroomGeneration/);
  assert.match(api, /\/api\/v1\/classroom\/jobs\/\$\{encodeURIComponent\(jobId\)\}/);
  assert.match(api, /\/jobs\/\$\{encodeURIComponent\(jobId\)\}\/events/);
  assert.match(api, /getClassroomJob/);
  // The follower snapshots first (reconnect path) then follows live SSE.
  assert.match(api, /followClassroomJob/);
  assert.match(api, /snapshot\.events/);
  const page = read("app/(utility)/space/classroom/page.tsx");
  // Unfinished jobs surface a recovery bar on the list page.
  assert.match(page, /data-classroom-job-resume=""/);
  assert.match(page, /knorvia\.classroom\.activeJobId/);
});

test("interactive widget iframe is sandboxed (T3 attribute snapshot)", () => {
  const player = read("components/classroom/ClassroomPlayer.tsx");
  // The widget iframe renders srcdoc inside a strict sandbox.
  assert.match(player, /data-classroom-widget=""/);
  assert.match(player, /srcDoc=\{scene\.html\}/);
  const iframeMatch = player.match(/<iframe[\s\S]*?\/>/);
  assert.ok(iframeMatch, "player must contain the widget iframe");
  const iframe = iframeMatch[0];
  assert.match(iframe, /sandbox="allow-scripts"/);
  assert.match(iframe, /referrerPolicy="no-referrer"/);
  assert.doesNotMatch(iframe, /allow-same-origin/);
  assert.match(player, /data-classroom-interactive=""/);
  // The interactive branch only renders for interactive scenes.
  const interactiveMatch = player.match(
    /scene\.type === "interactive" && scene\.html/,
  );
  assert.ok(interactiveMatch);
});

test("editor dispatches atomic PATCH ops for rename, delete, reorder (T4)", () => {
  const editor = read("components/classroom/ClassroomEditor.tsx");
  const api = read("lib/classroom-api.ts");
  const player = read("components/classroom/ClassroomPlayer.tsx");
  // The editor builds op payloads; the client PATCHes {ops:[...]} and the
  // player refreshes from the response document.
  assert.match(editor, /type: "retitle", scene_id: scene\.id/);
  assert.match(editor, /type: "delete_scene", scene_id: scene\.id/);
  assert.match(editor, /type: "reorder", ordered_ids: moved/);
  assert.match(editor, /type: "quiz_edit", scene_id: scene\.id/);
  assert.match(editor, /type: "insert_blank", at: sceneIndex \+ 1/);
  assert.match(api, /patchClassroom/);
  assert.match(api, /method: "PATCH"/);
  assert.match(api, /JSON\.stringify\(\{ ops \}\)/);
  assert.match(player, /data-classroom-edit-toggle=""/);
  assert.match(player, /onDocumentUpdated/);
  // The editor lives in its own file and stays below the size guard.
  assert.ok(editor.split("\n").length < 600, "editor file unexpectedly large");
});
