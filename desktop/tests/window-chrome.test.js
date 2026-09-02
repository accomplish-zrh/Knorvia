"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  TITLEBAR_HEIGHT,
  WINDOW_CORNER_RADIUS,
  OVERLAY,
  overlayForColorScheme,
  windowMaterialForFrost,
  windowMaterialForTheme,
  browserWindowChrome,
  sanitizeOverlay,
  sanitizeMaterial,
  fromMainWindow,
} = require("../window-chrome");

const desktopRoot = path.resolve(__dirname, "..");

test("Windows chrome hides the system caption and overlays native buttons", () => {
  const chrome = browserWindowChrome("win32", { dark: false });
  assert.equal(chrome.titleBarStyle, "hidden");
  assert.deepEqual(chrome.titleBarOverlay, {
    color: OVERLAY.light.color,
    symbolColor: OVERLAY.light.symbolColor,
    height: TITLEBAR_HEIGHT,
  });
  assert.equal(chrome.frame, undefined);
  assert.notEqual(chrome.transparent, true);
  assert.equal(chrome.roundedCorners, true);
  assert.equal(chrome.maximizable, true);
  assert.equal(chrome.backgroundMaterial, "none");
  assert.equal(chrome.backgroundColor, OVERLAY.light.color);
  assert.equal(WINDOW_CORNER_RADIUS, 16);
});

test("Windows dark splash matches the loading-page canvas", () => {
  const chrome = browserWindowChrome("win32", { dark: true });
  assert.equal(chrome.titleBarOverlay.color, OVERLAY.dark.color);
  assert.equal(chrome.titleBarOverlay.symbolColor, OVERLAY.dark.symbolColor);
  assert.equal(chrome.backgroundColor, OVERLAY.dark.color);
});

test("desktop loading page keeps BootSplash v4 markers", () => {
  const src = readFileSync(path.join(desktopRoot, "main.js"), "utf8");
  assert.match(src, /class="aura"/);
  assert.match(src, /class="halo"/);
  assert.match(src, /class="sheen"/);
  assert.match(src, /class="mark"/);
  assert.match(src, /class="rule"/);
  assert.match(src, /BootSplash v4/);
  assert.match(src, /rx="28"/);
  assert.equal((src.match(/class="mote"/g) || []).length, 0);
  assert.doesNotMatch(src, /@keyframes breathe/);
});

test("Windows frost uses acrylic so other apps show through, on any theme", () => {
  const chrome = browserWindowChrome("win32", { theme: "snow", frost: true });
  assert.equal(chrome.titleBarStyle, "hidden");
  assert.notEqual(chrome.transparent, true);
  assert.equal(chrome.roundedCorners, true);
  assert.equal(chrome.backgroundMaterial, "acrylic");
  assert.equal(chrome.backgroundColor, "#00000000");
  assert.equal(chrome.titleBarOverlay.color, "#00000000");
  assert.deepEqual(windowMaterialForFrost(true, "dark", "win32"), {
    material: "acrylic",
    backgroundColor: "#00000000",
    vibrancy: null,
  });
  assert.equal(windowMaterialForTheme("snow", "win32").material, "none");
});

test("macOS frost uses under-window vibrancy", () => {
  const chrome = browserWindowChrome("darwin", { theme: "dark", frost: true });
  assert.equal(chrome.titleBarStyle, "hiddenInset");
  assert.equal(chrome.vibrancy, "under-window");
  assert.equal(chrome.transparent, true);
  assert.equal(chrome.backgroundColor, "#00000000");
  assert.equal(chrome.backgroundMaterial, undefined);
});

test("opaque themes never enable a system backdrop", () => {
  assert.equal(windowMaterialForTheme("snow", "win32").material, "none");
  assert.equal(windowMaterialForTheme("dark", "win32").material, "none");
  assert.equal(browserWindowChrome("win32", { theme: "snow" }).backgroundMaterial, "none");
});

test("macOS uses hiddenInset traffic lights instead of a caption bar", () => {
  const chrome = browserWindowChrome("darwin", { dark: false });
  assert.equal(chrome.titleBarStyle, "hiddenInset");
  assert.deepEqual(chrome.trafficLightPosition, { x: 14, y: 12 });
  assert.equal(chrome.titleBarOverlay, undefined);
  assert.equal(chrome.frame, undefined);
  assert.equal(chrome.transparent, true);
});

test("Linux is frameless so the renderer can draw caption buttons", () => {
  const chrome = browserWindowChrome("linux", { dark: false });
  assert.equal(chrome.frame, false);
  assert.equal(chrome.titleBarOverlay, undefined);
  assert.equal(chrome.transparent, undefined);
  assert.equal(chrome.backgroundMaterial, undefined);
});

test("overlay sanitizer accepts hex colors and rejects height / junk", () => {
  assert.deepEqual(
    sanitizeOverlay({ color: "#1a1918", symbolColor: "#e8e4de", height: 80 }),
    { color: "#1a1918", symbolColor: "#e8e4de" },
  );
  assert.equal(sanitizeOverlay({ color: "red" }), null);
  assert.equal(sanitizeOverlay({ symbolColor: "#fff" }), null);
  assert.equal(sanitizeOverlay(null), null);
  assert.equal(sanitizeMaterial("acrylic"), "acrylic");
  assert.equal(sanitizeMaterial("blur"), null);
});

test("fromMainWindow only accepts the live BrowserWindow contents", () => {
  const webContents = {};
  assert.equal(fromMainWindow({ sender: webContents }, { webContents }), true);
  assert.equal(fromMainWindow({ sender: {} }, { webContents }), false);
  assert.equal(fromMainWindow({ sender: webContents }, null), false);
});

test("overlayForColorScheme keeps a 36px caption overlay", () => {
  assert.equal(overlayForColorScheme(false).height, 36);
  assert.equal(TITLEBAR_HEIGHT, 36);
});

test("win32 corner helper refuses a missing window", () => {
  const { applyWindowCornerRegion } = require("../win32-corners");
  assert.equal(applyWindowCornerRegion(null, 16), false);
});

test("the packaged shell wires window material only through sanitized IPC", () => {
  const main = readFileSync(path.join(desktopRoot, "main.js"), "utf8");
  const preload = readFileSync(path.join(desktopRoot, "preload.js"), "utf8");
  const pack = readFileSync(path.join(desktopRoot, "package.json"), "utf8");
  assert.match(main, /require\("\.\/window-chrome"\)/);
  assert.match(main, /browserWindowChrome\(process\.platform/);
  assert.match(main, /-webkit-app-region:drag/);
  assert.match(main, /knorvia:titlebar-overlay/);
  assert.match(main, /knorvia:window-material/);
  assert.match(main, /background:\$\{glass \? "transparent"/);
  assert.doesNotMatch(main, /enable-transparent-visuals/);
  assert.match(main, /liveBackdrop/);
  assert.match(main, /require\("\.\/win32-corners"\)/);
  assert.match(main, /refreshWindowShape/);
  assert.match(main, /border-radius:\$\{WINDOW_CORNER_RADIUS\}px/);
  assert.match(preload, /captionOverlay:\s*process\.platform === "win32"/);
  assert.match(preload, /setTitleBarOverlay/);
  assert.match(preload, /setWindowMaterial/);
  assert.match(pack, /window-chrome\.js/);
  assert.match(pack, /win32-corners\.js/);
  assert.match(pack, /wallpaper\.js/);
});
