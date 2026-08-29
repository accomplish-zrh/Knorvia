import test from "node:test";
import assert from "node:assert/strict";

import {
  BUILTIN_WALLPAPERS,
  DEFAULT_WALLPAPER_DIM,
  clampWallpaperDim,
  sanitizeWallpaperFit,
} from "../lib/wallpaper";

test("ships several original campus wallpapers", () => {
  assert.ok(BUILTIN_WALLPAPERS.length >= 3);
  for (const item of BUILTIN_WALLPAPERS) {
    assert.match(item.src, /^\/wallpapers\/.+\.(jpg|jpeg|png|webp)$/);
    assert.notEqual(item.id, "none");
    assert.notEqual(item.id, "custom");
  }
});

test("wallpaper dim clamps to a readable 0-100 range", () => {
  assert.equal(clampWallpaperDim(Number.NaN), DEFAULT_WALLPAPER_DIM);
  assert.equal(clampWallpaperDim(-8), 0);
  assert.equal(clampWallpaperDim(140), 100);
  assert.equal(clampWallpaperDim(32.4), 32);
});

test("wallpaper fit only accepts cover or contain", () => {
  assert.equal(sanitizeWallpaperFit("contain"), "contain");
  assert.equal(sanitizeWallpaperFit("cover"), "cover");
  assert.equal(sanitizeWallpaperFit("stretch"), "cover");
});
