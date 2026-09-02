const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const desktopRoot = path.join(__dirname, "..");
const pkg = JSON.parse(
  fs.readFileSync(path.join(desktopRoot, "package.json"), "utf8"),
);

test("desktop ships Knorvia 1.1.0-dev NSIS installer settings", () => {
  assert.equal(pkg.version, "1.1.0-dev");
  assert.equal(pkg.build.productName, "Knorvia");
  assert.equal(pkg.scripts.dist, "electron-builder --win nsis");
  assert.equal(pkg.build.directories.output, "../release");
  assert.equal(pkg.build.nsis.artifactName, "Knorvia-${version}-setup.${ext}");
  assert.ok(
    pkg.build.files.includes("wallpaper.js"),
    "wallpaper.js must stay in the asar",
  );
});

test("does not add a second Ctrl+K command palette in desktop", () => {
  const main = fs.readFileSync(path.join(desktopRoot, "main.js"), "utf8");
  assert.doesNotMatch(main, /CommandPalette|ctrl\+k/i);
});
