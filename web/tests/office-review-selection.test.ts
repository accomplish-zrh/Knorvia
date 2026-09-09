/** Frozen office selection: session-scoped, and the review shows its evidence. */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  clearPendingOfficeSelection,
  setPendingOfficeSelection,
  takePendingOfficeSelection,
} from "@/lib/office-selection";

const webRoot = process.cwd();

function read(rel: string) {
  return readFileSync(path.join(webRoot, rel), "utf8");
}

const SELECTION = {
  draftId: "aaaa1111",
  artifactId: "bbbb2222",
  sheet: "Data",
  range: "A1:B3",
  revision: 2,
};

test("a selection is consumed only by the session that set it", () => {
  setPendingOfficeSelection(SELECTION, "session-a");
  assert.equal(takePendingOfficeSelection("session-b"), null);
  // Still there for its own session, and read-once.
  assert.deepEqual(takePendingOfficeSelection("session-a"), SELECTION);
  assert.equal(takePendingOfficeSelection("session-a"), null);
});

test("clearing respects the session that owns the selection", () => {
  setPendingOfficeSelection(SELECTION, "session-a");
  clearPendingOfficeSelection("session-b");
  assert.deepEqual(takePendingOfficeSelection("session-a"), SELECTION);

  setPendingOfficeSelection(SELECTION, "session-a");
  clearPendingOfficeSelection("session-a");
  assert.equal(takePendingOfficeSelection("session-a"), null);
});

test("an unscoped selection is always cleared", () => {
  setPendingOfficeSelection(SELECTION);
  clearPendingOfficeSelection("anything");
  assert.equal(takePendingOfficeSelection(), null);
});

test("the grid selects a rectangle by click, drag and shift-arrow", () => {
  const grid = read("components/chat/preview/previewers/SpreadsheetGrid.tsx");
  assert.match(grid, /const \[anchor, setAnchor\] = useState<GridCell>/);
  assert.match(grid, /const \[focus, setFocus\] = useState<GridCell>/);
  assert.match(grid, /onMouseDown=\{\(event\) =>\s*onMouseDownCell/);
  assert.match(grid, /onMouseEnter=\{\(\) => onMouseEnterCell/);
  assert.match(grid, /extend: event\.shiftKey/);
  assert.match(grid, /data-selection-range=/);
});

test("the grid highlights the cells the draft changed", () => {
  const grid = read("components/chat/preview/previewers/SpreadsheetGrid.tsx");
  assert.match(grid, /changedCells\?: string\[\]/);
  assert.match(grid, /changed\.has\(`\$\{sheet\.name\}!\$\{address\}`\)/);
  assert.match(grid, /data-changed=\{isChanged \? "true" : undefined\}/);
});

test("the previewer reports a range, not a single cell", () => {
  const preview = read("components/chat/preview/previewers/XlsxPreview.tsx");
  assert.match(preview, /onSelectionChange\?: \(sheet: string, range: string\) => void/);
  assert.match(preview, /from === to \? from : `\$\{from\}:\$\{to\}`/);
  assert.match(preview, /changedCells=\{changedCells\}/);
});

test("the review card renders diff and verification evidence", () => {
  const card = read("components/chat/home/OfficeDraftCard.tsx");
  assert.match(card, /<DiffSummary diff=\{artifact\.lastDiff \?\? null\} \/>/);
  assert.match(card, /<VerificationBadges/);
  assert.match(card, /artifact\.originRef/);
  assert.match(card, /data-diff-summary=""/);
  assert.match(card, /data-verification=""/);
  assert.match(card, /Untouched parts intact/);
  assert.match(card, /Formulas written, not computed/);
});

test("closing the preview drops the frozen selection", () => {
  const card = read("components/chat/home/OfficeDraftCard.tsx");
  assert.match(card, /const closePreview = \(\) => \{/);
  // Both the backdrop and the X button go through it.
  assert.match(card, /onClick=\{closePreview\}/);
  assert.match(card, /onClick=\{closePreview\}\n\s*className="rounded-md p-1/);
  assert.match(card, /return \(\) => clearPendingOfficeSelection\(sessionId\)/);
  assert.match(card, /setPendingOfficeSelection\(\s*\{[^}]*\},\s*sessionId,\s*\)/);
});

test("a library write-back is labelled, never offered as a dead file link", () => {
  const card = read("components/chat/home/OfficeDraftCard.tsx");
  assert.match(card, /const showFiles = canShowOfficeDraftFiles\(liveStatus\)/);
  assert.match(card, /\{showFiles \? \(\s*<ul/);
  // Preview is gated on the url existing, so an entry with no file cannot open it.
  assert.match(card, /\{file\.url \? \(\s*<button/);
  assert.match(card, /file\.kind === "library" \? \(/);
  assert.match(card, /data-library-entry=\{file\.library_entry_id \|\| ""\}/);
  assert.match(card, /Written back to the library/);

  const draft = read("lib/office-draft.ts");
  assert.match(draft, /kind\?: string;/);
  assert.match(draft, /library_entry_id\?: string;/);
  assert.match(draft, /const kind = firstText\(row\.kind\);/);
  assert.match(draft, /\.\.\.\(entryId \? \{ library_entry_id: entryId \} : \{\}\)/);
});
