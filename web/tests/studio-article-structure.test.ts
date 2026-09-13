import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const componentPath = path.join(process.cwd(), "components", "native", "StudioArticle.tsx");

function readComponent() {
  return fs.readFileSync(componentPath, "utf8");
}

test("StudioArticle keeps durable drafts in sync with the edit state", () => {
  const source = readComponent();
  // Draft persistence wiring (P09).
  assert.match(source, /storeArticleDraft\(/, "edits must be written to the draft store");
  assert.match(source, /loadArticleDrafts\(/, "opening the dialog must restore drafts");
  assert.match(source, /clearArticleDraft\(/, "saved work must retire its draft");
  assert.match(source, /draftReplayDecision\(/, "project drafts replay through a revision decision");
  // Poll must not revert dirty local edits.
  assert.match(source, /dirtyRef\.current\) setProject\(p\); else applyProject\(p\)/);
  // Switching projects with unsaved changes resolves explicitly.
  assert.match(source, /保存并切换|Save, then switch/);
  assert.match(source, /保留草稿并切换|Keep draft, then switch/);
  assert.match(source, /放弃修改|Discard changes/);
  // A lost save response is resolved through read-back with a stable key.
  assert.match(source, /idempotencyKey: key/);
  assert.match(source, /上次保存实际已成功|The previous save did land/);
  // Storage failures and rescue exports are user-visible.
  assert.match(source, /此浏览器无法保存草稿|This browser cannot store drafts/);
  assert.match(source, /draftToMarkdown\(/);
  // Creating a project retires the pre-create draft.
  assert.match(source, /clearArticleDraft\(draftStore\(\), workspaceId, null\)/);
});

test("StudioArticle generation guard prevents stale async responses from landing", () => {
  const source = readComponent();
  assert.match(source, /const generation = useRef\(0\)/);
  assert.match(source, /generation\.current !== gen/, "every async apply checks its generation");
  assert.match(source, /\+\+generation\.current/);
});

test("desktop article-video save accepts an idempotency key", () => {
  const enginePath = path.join(process.cwd(), "..", "desktop", "article-video.js");
  const source = fs.readFileSync(enginePath, "utf8");
  assert.match(source, /idempotencyKey\.slice\(0, 128\)/);
  assert.match(source, /saveMemo\.set\(memo, result\)/);
});
