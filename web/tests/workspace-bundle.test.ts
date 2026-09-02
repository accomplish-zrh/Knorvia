import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

test("workspace zip client never packs secrets", () => {
  const lib = fs.readFileSync(
    path.join(process.cwd(), "lib/workspace-bundle.ts"),
    "utf8",
  );
  assert.match(lib, /WORKSPACE_SECRET_BASENAMES/);
  assert.match(lib, /\.env/);
  assert.match(lib, /api_keys\.json/);
  assert.match(lib, /\/api\/v1\/workspace\/export/);
  assert.match(lib, /\/api\/v1\/workspace\/import/);
});

test("space dashboard exposes local zip export/import", () => {
  const dash = fs.readFileSync(
    path.join(process.cwd(), "components/space/SpaceDashboard.tsx"),
    "utf8",
  );
  const card = fs.readFileSync(
    path.join(process.cwd(), "components/space/WorkspaceBundleCard.tsx"),
    "utf8",
  );
  assert.match(dash, /WorkspaceBundleCard/);
  assert.match(card, /Export workspace zip/);
  assert.match(card, /Import workspace zip/);
});
