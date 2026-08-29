"use strict";

/**
 * In-app wallpaper layer. A photo sits under the existing UI; window frost
 * (acrylic / vibrancy in window-chrome.js) is unchanged and still the only
 * glass switch. Custom files live in userData, not the repo.
 */

const fs = require("fs");
const path = require("path");

const BUILTINS = [
  { id: "campus-quad", title: "Golden Quad", file: "campus-quad.jpg" },
  { id: "campus-library", title: "Library evening", file: "campus-library.jpg" },
  { id: "campus-lake", title: "Reading lawn", file: "campus-lake.jpg" },
  { id: "campus-courtyard", title: "Covered walk", file: "campus-courtyard.jpg" },
  { id: "campus-night", title: "Lecture Hall Dusk", file: "campus-night.jpg" },
];

const BUILTIN_IDS = new Set(BUILTINS.map((item) => item.id));
const MIME = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};
const MAX_CUSTOM_BYTES = 8 * 1024 * 1024;

function electron() {
  return require("electron");
}

function builtinsDir() {
  return path.join(__dirname, "wallpapers");
}

function settingsDir() {
  return path.join(electron().app.getPath("userData"), "settings");
}

function statePath() {
  return path.join(settingsDir(), "wallpaper.json");
}

function customDir() {
  return path.join(settingsDir(), "wallpapers");
}

function catalog() {
  return BUILTINS.map((item) => ({
    id: item.id,
    title: item.title,
    src: `/wallpapers/${item.file}`,
  }));
}

function readState() {
  try {
    const raw = JSON.parse(fs.readFileSync(statePath(), "utf8"));
    if (raw && typeof raw.id === "string") return { id: raw.id };
  } catch {
    /* missing or unreadable */
  }
  return { id: "none" };
}

function writeState(id) {
  fs.mkdirSync(settingsDir(), { recursive: true });
  fs.writeFileSync(statePath(), `${JSON.stringify({ id }, null, 2)}\n`, "utf8");
}

function fileToDataUrl(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mime = MIME[ext];
  if (!mime) return null;
  const buf = fs.readFileSync(filePath);
  return `data:${mime};base64,${buf.toString("base64")}`;
}

function findCustomFile() {
  const dir = customDir();
  if (!fs.existsSync(dir)) return null;
  const names = fs.readdirSync(dir).filter((name) => MIME[path.extname(name).toLowerCase()]);
  if (!names.length) return null;
  names.sort();
  const custom = names.find((name) => name.startsWith("custom."));
  return path.join(dir, custom || names[0]);
}

function removeCustomFiles() {
  const dir = customDir();
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    if (MIME[path.extname(name).toLowerCase()]) {
      try { fs.unlinkSync(path.join(dir, name)); } catch { /* ignore */ }
    }
  }
}

function getState() {
  const { id } = readState();
  const builtins = catalog();
  if (!id || id === "none") return { id: "none", src: null, builtins };
  if (id === "custom") {
    const found = findCustomFile();
    return { id: "custom", src: found ? fileToDataUrl(found) : null, builtins };
  }
  const item = BUILTINS.find((entry) => entry.id === id);
  if (!item) return { id: "none", src: null, builtins };
  return { id, src: `/wallpapers/${item.file}`, builtins };
}

function setBuiltin(id) {
  if (id === "none" || id == null || id === "") return clear();
  if (!BUILTIN_IDS.has(id)) return getState();
  writeState(id);
  return getState();
}

function clear() {
  writeState("none");
  removeCustomFiles();
  return getState();
}

async function importCustom(browserWindow) {
  const { dialog } = electron();
  const result = await dialog.showOpenDialog(browserWindow, {
    title: "Choose wallpaper",
    filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp"] }],
    properties: ["openFile"],
  });
  if (result.canceled || !result.filePaths?.[0]) return getState();
  const source = result.filePaths[0];
  const ext = path.extname(source).toLowerCase();
  if (!MIME[ext]) return getState();
  let stat;
  try { stat = fs.statSync(source); } catch { return getState(); }
  if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_CUSTOM_BYTES) return getState();
  const destDir = customDir();
  fs.mkdirSync(destDir, { recursive: true });
  removeCustomFiles();
  const dest = path.join(destDir, `custom${ext}`);
  fs.copyFileSync(source, dest);
  writeState("custom");
  return getState();
}

module.exports = {
  BUILTINS,
  builtinsDir,
  settingsDir,
  getState,
  setBuiltin,
  clear,
  importCustom,
};