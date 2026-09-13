import test from "node:test";
import assert from "node:assert/strict";
import { describeOutput, downloadAvailable, formatDuration, pruneSlots, sanitizeDownloadName, slotMetaLabel, type MediaSlot } from "../lib/native-media-review";

const slot = (overrides: Partial<MediaSlot> = {}): MediaSlot => ({ status: "ready", url: "blob:abc", ...overrides });

test("object URLs are pruned with their output identity; at most two stay alive", () => {
  const slots = { a: slot(), b: slot(), c: slot(), d: slot({ status: "loading" }) };
  const { next, revoked } = pruneSlots(slots, ["c", "d"]);
  assert.deepEqual(Object.keys(next).sort(), ["c", "d"]);
  // a and b lost their URLs; d was loading (never had one).
  assert.deepEqual(revoked.sort(), ["a", "b"]);
  const overflow = pruneSlots({ one: slot(), two: slot(), three: slot() }, ["one", "two", "three"]);
  assert.equal(overflow.revoked.length, 1);
  assert.equal(Object.keys(overflow.next).length, 2);
});

test("download requires this output's own ready URL; loading and error slots never pass", () => {
  assert.equal(downloadAvailable(slot()), true);
  assert.equal(downloadAvailable(slot({ status: "loading", url: undefined })), false);
  assert.equal(downloadAvailable(slot({ status: "error", url: undefined })), false);
  assert.equal(downloadAvailable(undefined), false);
  // A decode failure keeps the bytes downloadable.
  assert.equal(downloadAvailable(slot({ decodeError: true })), true);
});

test("durations and sizes render as bounded human labels without inventing values", () => {
  assert.equal(formatDuration(65), "1:05");
  assert.equal(formatDuration(5), "0:05");
  assert.equal(formatDuration(undefined), "");
  assert.equal(formatDuration(Number.NaN), "");
  const zh = (zhText: string) => zhText;
  const label = slotMetaLabel(slot({ width: 1920, height: 1080, duration: 75 }), "2.0 MB", zh);
  assert.match(label, /1920×1080/);
  assert.match(label, /1:15/);
  assert.match(label, /2\.0 MB/);
  assert.equal(slotMetaLabel(undefined, "12 KB", zh), "12 KB");
});

test("download names keep hostile characters out of the filename", () => {
  assert.equal(sanitizeDownloadName("shot<>:|?.png"), "shot-----.png");
  assert.equal(sanitizeDownloadName("normal_name-1.mp4"), "normal_name-1.mp4");
  assert.match(describeOutput({ name: "a.png", mime: "image/png", size: 1, sha256: "f".repeat(64) }), /^a\.png \(image\/png\)$/);
});
