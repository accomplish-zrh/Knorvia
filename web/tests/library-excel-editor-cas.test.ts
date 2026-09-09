/** Human save chain for library spreadsheets: CAS anchored when the file loads. */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const webRoot = process.cwd();

function read(rel: string) {
  return readFileSync(path.join(webRoot, rel), "utf8");
}

test("editor fingerprints the bytes it rendered, before any edit", () => {
  const editor = read("components/library/LibraryExcelEditor.tsx");
  assert.match(editor, /const anchor = useRef<string>\(""\)/);
  assert.match(editor, /await contentFingerprint\(src\.buffer\)/);
  // The fingerprint is taken from the fetched buffer, not from a later request.
  assert.match(editor, /crypto\.subtle\.digest\("SHA-256", buffer\)/);
});

test("save opens its draft against the loaded version", () => {
  const editor = read("components/library/LibraryExcelEditor.tsx");
  assert.match(editor, /openOfficeDraftFromSource\(\s*`library:\$\{entryId\}`,\s*anchor\.current,\s*\)/);
  // Without an anchor the conflict check would compare the wrong version, so
  // saving is refused instead of silently overwriting.
  assert.match(editor, /if \(!anchor\.current\)/);
  assert.match(editor, /saving is disabled here/);
});

test("a published save re-anchors so the next save sends only new edits", () => {
  const editor = read("components/library/LibraryExcelEditor.tsx");
  assert.match(editor, /baseline\.current = currentModel;/);
  assert.match(editor, /anchor\.current = publishedHash/);
  assert.match(editor, /reopen this entry before making more edits/);
  assert.match(editor, /const merged = await patchOfficeDraft\(draft\.draftId, "merge"\)/);
});

test("draft client carries the evidence fields the card confirms from", () => {
  const client = read("lib/office-draft.ts");
  assert.match(client, /lastDiff: asDiff\(row\.last_diff/);
  assert.match(client, /lastVerification: asVerification\(row\.last_verification/);
  assert.match(client, /originRef: firstText\(row\.origin_ref/);
  assert.match(client, /currentHash: firstText\(row\.current_hash/);
  assert.match(client, /expected_base_hash: expectedBaseHash/);
});
