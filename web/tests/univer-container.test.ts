import test from "node:test";
import assert from "node:assert/strict";

import { previewKindFor } from "../components/chat/preview/previewerFor";
import {
  containerManifestUrl,
  containerUnitUrl,
  isUniverFilename,
  parseUniverManifest,
  previewKindForUnitType,
  unitLabel,
} from "../lib/univer-container";

test("previewKindFor routes .univer to the tabbed container preview", () => {
  assert.equal(previewKindFor({ filename: "pack.univer" }), "univer");
  assert.equal(isUniverFilename("pack.univer"), true);
  assert.equal(isUniverFilename("pack.xlsx"), false);
});

test("container URL helpers append the unpack proxy path", () => {
  const base = "/api/outputs/workspace/chat/session/exec/pack.univer";
  assert.equal(containerManifestUrl(base), `${base}/container`);
  assert.equal(
    containerUnitUrl(`${base}?cache=1`, "sheet"),
    `${base}/container?unit=sheet`,
  );
  assert.equal(
    containerUnitUrl(base, "slide 1"),
    `${base}/container?unit=slide%201`,
  );
});

test("parseUniverManifest keeps units and cross-unit refs", () => {
  const manifest = parseUniverManifest({
    version: 1,
    units: [
      { id: "sheet", type: "sheet", file: "units/sheet.xlsx", name: "Sales" },
      { id: "slide", type: "slide", file: "units/slide.pptx" },
      { id: "bad", type: "pdf", file: "units/bad.pdf" },
    ],
    refs: [
      { from: "slide", to: "sheet", range: "A1:B5", kind: "data_source" },
      { from: "slide", to: "", range: "A1" },
    ],
  });
  assert.equal(manifest.units.length, 2);
  assert.equal(unitLabel(manifest.units[0]), "Sales");
  assert.equal(unitLabel(manifest.units[1]), "slide");
  assert.deepEqual(manifest.refs, [
    { from: "slide", to: "sheet", range: "A1:B5", kind: "data_source" },
  ]);
  assert.equal(previewKindForUnitType("sheet"), "xlsx");
  assert.equal(previewKindForUnitType("doc"), "docx");
  assert.equal(previewKindForUnitType("slide"), "pptx");
  assert.equal(previewKindForUnitType("pdf"), null);
});
