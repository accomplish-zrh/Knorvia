import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  DESKTOP_TITLEBAR_HEIGHT,
  WINDOW_CORNER_RADIUS,
  titleBarOverlayForTheme,
  windowMaterialForFrost,
  windowMaterialForTheme,
} from "../lib/desktop-shell";
import { frostMix } from "../lib/window-frost";

const webRoot = process.cwd();

function read(rel: string) {
  return readFileSync(path.join(webRoot, rel), "utf8");
}

test("titleBarOverlayForTheme matches each canvas, not a separate caption color", () => {
  assert.deepEqual(titleBarOverlayForTheme("snow"), {
    color: "#ffffff",
    symbolColor: "#0d0d0d",
  });
  assert.deepEqual(titleBarOverlayForTheme("light"), {
    color: "#fdfcf9",
    symbolColor: "#1c1816",
  });
  assert.deepEqual(titleBarOverlayForTheme("dark"), {
    color: "#1a1918",
    symbolColor: "#e8e4de",
  });
  assert.deepEqual(titleBarOverlayForTheme("glass"), {
    color: "#eaf2f8",
    symbolColor: "#10151c",
  });
  assert.deepEqual(titleBarOverlayForTheme("dark", true), {
    color: "#00000000",
    symbolColor: "#e8e4de",
  });
  assert.equal(DESKTOP_TITLEBAR_HEIGHT, 36);
  assert.equal(WINDOW_CORNER_RADIUS, 16);
});

test("window frost uses acrylic on any colour theme", () => {
  assert.deepEqual(windowMaterialForFrost(true, "snow", "win32"), {
    material: "acrylic",
    backgroundColor: "#00000000",
    vibrancy: null,
  });
  assert.deepEqual(windowMaterialForFrost(true, "dark", "darwin"), {
    material: "none",
    backgroundColor: "#00000000",
    vibrancy: "under-window",
  });
  assert.equal(windowMaterialForTheme("glass", "win32").material, "none");
  assert.equal(windowMaterialForTheme("dark", "win32").backgroundColor, "#1a1918");
});

test("frostMix raises see-through and plate solidity independently", () => {
  const clear = frostMix(100, 100)
  const dense = frostMix(0, 0)
  assert.ok(clear.canvas < dense.canvas)
  assert.ok(clear.plate > dense.plate)
  assert.ok(clear.sidebar < clear.canvas)
});

test("AppShell reserves a frameless titlebar slot in the main column", () => {
  const source = read("components/layout/AppShell.tsx");
  assert.match(source, /data-desktop-main-chrome/);
  assert.match(source, /desktop-titlebar-space/);
});

test("sidebar header is a desktop drag region so the rail reaches the top edge", () => {
  const source = read("components/sidebar/SidebarShell.tsx");
  assert.match(source, /data-desktop-drag/);
  assert.match(source, /data-sidebar-header="expanded"/);
  assert.match(source, /data-sidebar-header="collapsed"/);
});

test("root layout mounts DesktopChrome and ThemeScript stamps data-desktop-chrome", () => {
  const layout = read("app/layout.tsx");
  const theme = read("components/ThemeScript.tsx");
  const chrome = read("components/layout/DesktopChrome.tsx");
  assert.match(layout, /DesktopChrome/);
  assert.match(layout, /WallpaperLayer/);
  assert.match(theme, /data-desktop-chrome/);
  assert.match(theme, /setTitleBarOverlay/);
  assert.match(theme, /setWindowMaterial/);
  assert.match(theme, /acrylic/);
  assert.match(theme, /data-window-frost/);
  assert.match(theme, /data-wallpaper/);
  assert.match(chrome, /captionOverlay/);
  assert.match(chrome, /syncDesktopChrome/);
  assert.match(chrome, /readStoredWindowFrost/);
  assert.match(chrome, /data-window-maximized/);
  const picker = read("components/common/PickerShell.tsx");
  assert.match(picker, /overflow-hidden rounded-2xl/);
});

test("globals.css only enables drag chrome inside the desktop shell", () => {
  const css = read("app/globals.css");
  assert.match(css, /html\[data-desktop-chrome\]/);
  assert.match(css, /--window-corner-radius:\s*16px/);
  assert.match(css, /:not\(\[data-window-maximized\]\)/);
  assert.match(css, /-webkit-app-region:\s*drag/);
  assert.match(css, /--desktop-titlebar-height/);
  assert.match(css, /\.desktop-titlebar-space \{[\s\S]*height:\s*0;/);
  assert.match(css, /html\[data-desktop-chrome="win32"\] \.desktop-titlebar-space/);
  assert.match(css, /\.desktop-drag-hit \{[\s\S]*pointer-events:\s*none;/);
  assert.match(css, /html\[data-window-frost\]/);
  assert.match(css, /html\[data-wallpaper\]/);
  assert.match(css, /data-wallpaper-layer/);
  assert.match(css, /background:\s*transparent/);
  assert.match(css, /html\[data-window-frost\] option/);
  assert.match(css, /html\[data-window-frost\] \[role="dialog"\]:not\(\[class\*="rounded"\]\):not\(\[class\*="bg-"\]\)/);
  assert.match(css, /-webkit-appearance:\s*none/);
  assert.match(css, /rgb\(0 0 0 \/ 0%\)/);
  assert.match(css, /text-\\\[var\\\(--background\\\)\\\]/);
});
