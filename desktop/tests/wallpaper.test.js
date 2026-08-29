"use strict";

const assert = require("node:assert/strict");
const { readFileSync, existsSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const wallpaper = require("../wallpaper");
const desktopRoot = path.resolve(__dirname, "..");

test("wallpaper builtins are original campus scenes on disk", () => {
  assert.ok(wallpaper.BUILTINS.length >= 3);
  for (const item of wallpaper.BUILTINS) {
    assert.equal(existsSync(path.join(desktopRoot, "wallpapers", item.file)), true, item.file);
  }
});

test("the packaged shell wires wallpaper IPC and ships images", () => {
  const main = readFileSync(path.join(desktopRoot, "main.js"), "utf8");
  const preload = readFileSync(path.join(desktopRoot, "preload.js"), "utf8");
  const pack = readFileSync(path.join(desktopRoot, "package.json"), "utf8");
  assert.match(main, /require\("\.\/wallpaper"\)/);
  assert.match(main, /knorvia:wallpaper-state/);
  assert.match(main, /knorvia:wallpaper-import/);
  assert.match(preload, /importCustom/);
  assert.match(pack, /wallpaper\.js/);
  assert.match(pack, /wallpapers\/\*\*\/\*/);
});
