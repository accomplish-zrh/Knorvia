import test from "node:test";
import assert from "node:assert/strict";

import { createPetRuntime, PET_LAYOUTS, STATE_ROWS, type PetState } from "../lib/native-pet";
import { composePreview, sequenceStateLabel, shotStateLabel } from "../lib/native-studio";

test("pet runtime maps task states to sprite rows one-way", () => {
  const runtime = createPetRuntime({ layout: PET_LAYOUTS[1], fps: 8 });
  runtime.setState("working", 0);
  const a = runtime.frame(10_000)!;
  const b = runtime.frame(10_250)!;
  assert.equal(a.row, STATE_ROWS.working);
  assert.notEqual(a.column, b.column);
  assert.equal(a.y, STATE_ROWS.working * 208);
  assert.equal(runtime.setState("dancing" as PetState), false, "unknown states are refused");
});

test("pet runtime honors reduced motion, holds outcomes, and stops when hidden", () => {
  const runtime = createPetRuntime({ layout: PET_LAYOUTS[1], reducedMotion: true });
  runtime.setState("working", 0);
  const still1 = runtime.frame(30_000)!;
  const still2 = runtime.frame(30_250)!;
  assert.equal(still1.index, still2.index, "reduced motion never animates");
  assert.equal(runtime.frame(30_500, { visible: false }), null);
  const outcomes = createPetRuntime({ layout: PET_LAYOUTS[1], outcomeHoldMs: 1000 });
  outcomes.setState("succeeded", 10_000);
  assert.equal(outcomes.frame(10_500)!.state, "succeeded");
  assert.equal(outcomes.frame(12_000)!.state, "idle", "outcome returns to idle after the hold");
});

test("sequence label helpers fall back to the raw state", () => {
  const t = (zh: string, en: string) => zh;
  assert.equal(sequenceStateLabel("running", t), "进行中");
  assert.equal(sequenceStateLabel("mystery", t), "mystery");
  assert.equal(shotStateLabel("waiting-dependency", t), "等待前一段");
});

test("compose preview puts the shared prompt before the shot prompt", () => {
  assert.equal(composePreview("全局", "第一幕"), "全局\n\n第一幕");
  assert.equal(composePreview(undefined, "第一幕"), "第一幕");
  assert.equal(composePreview("  ", "第一幕"), "第一幕");
});
