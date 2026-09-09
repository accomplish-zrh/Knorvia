"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { palettes, nativeBackdropSupported, readAppearance, saveAppearance } = require("../window-appearance");
const { browserWindowChrome, windowMaterialForFrost } = require("../window-chrome");

function luminance(hex) {
  const c = hex.slice(1).match(/../g).map(v => parseInt(v, 16) / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
  return c[0] * .2126 + c[1] * .7152 + c[2] * .0722;
}
function contrast(a, b) { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); }

test("reduced motion survives restart and older appearance writers", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "knorvia-motion-test-"));
  assert.equal(saveAppearance(dir, { theme: "snow", frost: false, reducedMotion: true }), true);
  assert.deepEqual(readAppearance(dir), { theme: "snow", frost: false, reducedMotion: true });
  assert.equal(saveAppearance(dir, { theme: "dusk", frost: true }), true);
  assert.deepEqual(readAppearance(dir), { theme: "dusk", frost: true, reducedMotion: true });
  assert.equal(saveAppearance(dir, { theme: "dusk", frost: true, reducedMotion: "false" }), false);
  assert.equal(readAppearance(dir).reducedMotion, true);
  assert.equal(saveAppearance(dir, { theme: "dusk", frost: true, reducedMotion: false }), true);
  assert.equal(readAppearance(dir).reducedMotion, false);
});

test("all palettes keep readable primary/secondary text and independent native frost", () => {
  for (const [id, { colors: c }] of Object.entries(palettes)) {
    for (const foreground of ["ink", "muted"]) for (const surface of ["bg", "sidebar", "soft"]) {
      assert.ok(contrast(c[foreground], c[surface]) >= 4.5, `${id}: ${foreground} on ${surface}`);
    }
    assert.ok(contrast(c.action, c["action-ink"]) >= 4.5, `${id}: button label`);
    for (const frost of [false, true]) {
      const win = browserWindowChrome("win32", { theme: id, frost });
      assert.equal(win.backgroundMaterial, frost ? "acrylic" : "none");
      assert.equal(win.backgroundColor, frost ? "#00000000" : c.bg);
      assert.equal(win.titleBarOverlay.symbolColor, c.ink);
      assert.notEqual(win.transparent, true, "native maximize/restore must remain available");
    }
    assert.equal(windowMaterialForFrost(true, id, "linux").backgroundColor, c.bg);
  }
});

test("unsupported Windows versions and other platforms never promise a native backdrop", () => {
  assert.equal(nativeBackdropSupported("win32", "10.0.22000"), false);
  assert.equal(nativeBackdropSupported("win32", "10.0.19045"), false);
  assert.equal(nativeBackdropSupported("win32", "10.0.22621"), true);
  assert.equal(nativeBackdropSupported("win32", "10.0.26200"), true);
  assert.equal(nativeBackdropSupported("win32", "garbage"), false);
  assert.equal(nativeBackdropSupported("linux", "6.8.0"), false);
  assert.equal(nativeBackdropSupported("darwin", "24.0.0"), true);
});

test("a fresh app instance recovers exactly the last theme/effect and rejects malformed preferences", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "knorvia-appearance-test-"));
  assert.equal(readAppearance(dir), null);
  for (const theme of Object.keys(palettes)) for (const frost of [true, false]) {
    assert.equal(saveAppearance(dir, { theme, frost, ignored: "never persisted" }), true);
    assert.deepEqual(readAppearance(dir), { theme, frost });
    assert.equal(fs.existsSync(path.join(dir, "window-appearance.json.tmp")), false);
  }
  const before = fs.readFileSync(path.join(dir, "window-appearance.json"), "utf8");
  for (const invalid of [{ theme: "__proto__", frost: true }, { theme: "snow", frost: "false" }, { theme: "constructor", frost: false }]) {
    assert.equal(saveAppearance(dir, invalid), false);
    assert.equal(fs.readFileSync(path.join(dir, "window-appearance.json"), "utf8"), before);
  }
  fs.writeFileSync(path.join(dir, "window-appearance.json"), "partial");
  assert.equal(readAppearance(dir), null);
  // Only this fixture's two explicitly named files are created; no user store is read.
});
